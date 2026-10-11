/**
 * APK 元数据提取：从 AndroidManifest.xml 读出应用名、版本号、包名与图标。
 *
 * 清单里的应用名（android:label）与图标（android:icon）通常写成资源 ID，
 * 还要再解一次 resources.arsc 才能拿到真正的字符串与图片路径，
 * 因此这里在 adbkit-apkreader 之上补了一份资源表解析。
 * 任何一步失败都只返回 null，不打断上传流程。
 */
import path from 'node:path';
import ApkReader from 'adbkit-apkreader';

/** 可作为图标使用的位图格式 */
const IMAGE_RE = /\.(png|webp|jpe?g|gif|bmp)$/i;
/** adbkit-apkreader 对资源引用的表示形式，如 resourceId:0x7f0a000e */
const REF_RE = /^resourceId:\s*(0x[0-9a-f]+)$/i;

/* ------------------------------ 字符串池 ------------------------------ */

/** UTF-8 字符串池的变长长度：1 字节，最高位为 1 时再读 1 字节拼接 */
function readLen8(buf, pos) {
  if (pos >= buf.length) return { value: 0, next: buf.length };
  let first = buf[pos];
  pos += 1;
  if (first & 0x80) {
    if (pos >= buf.length) return { value: 0, next: buf.length };
    first = ((first & 0x7f) << 8) | buf[pos];
    pos += 1;
  }
  return { value: first, next: pos };
}

/** UTF-16 字符串池的变长长度：2 字节，最高位为 1 时再读 2 字节拼接 */
function readLen16(buf, pos) {
  if (pos + 2 > buf.length) return { value: 0, next: buf.length };
  let first = buf.readUInt16LE(pos);
  pos += 2;
  if (first & 0x8000) {
    if (pos + 2 > buf.length) return { value: 0, next: buf.length };
    first = ((first & 0x7fff) << 16) | buf.readUInt16LE(pos);
    pos += 2;
  }
  return { value: first, next: pos };
}

/** 解析一个 RES_STRING_POOL_TYPE（0x0001）块，返回字符串数组与块大小 */
function readStringPool(buf, start) {
  if (start < 0 || start + 28 > buf.length) return null;
  if (buf.readUInt16LE(start) !== 0x0001) return null;
  const headerSize = buf.readUInt16LE(start + 2);
  const chunkSize = buf.readUInt32LE(start + 4);
  const stringCount = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const utf8 = (flags & 0x100) !== 0;
  const strings = [];

  for (let i = 0; i < stringCount; i += 1) {
    const offPos = start + headerSize + i * 4;
    if (offPos + 4 > buf.length) break;
    let pos = start + stringsStart + buf.readUInt32LE(offPos);
    if (pos < 0 || pos >= buf.length) {
      strings.push('');
      continue;
    }
    if (utf8) {
      pos = readLen8(buf, pos).next; // 字符数，仅跳过用
      const byteLen = readLen8(buf, pos);
      pos = byteLen.next;
      const end = Math.min(pos + byteLen.value, buf.length);
      strings.push(buf.toString('utf8', pos, end));
    } else {
      const charLen = readLen16(buf, pos);
      pos = charLen.next;
      const end = Math.min(pos + charLen.value * 2, buf.length);
      strings.push(buf.toString('utf16le', pos, end));
    }
  }
  return { strings, size: chunkSize };
}

/* ------------------------------ 资源表 ------------------------------ */

/** 解析一个 RES_TABLE_TYPE（0x0002）文件，得到 resId → 资源条目 的映射 */
function parseResources(buf) {
  if (!buf || buf.length < 12 || buf.readUInt16LE(0) !== 0x0002) return null;
  const headerSize = buf.readUInt16LE(2);
  const tableSize = Math.min(buf.readUInt32LE(4), buf.length);
  const globalPool = readStringPool(buf, headerSize);
  if (!globalPool) return null;

  const entries = new Map();
  let pos = headerSize + globalPool.size;

  while (pos + 8 <= tableSize) {
    const type = buf.readUInt16LE(pos);
    const chunkSize = buf.readUInt32LE(pos + 4);
    if (chunkSize < 8 || pos + chunkSize > tableSize) break;
    if (type === 0x0200) parsePackage(buf, pos, globalPool.strings, entries);
    pos += chunkSize;
  }
  return { entries, globalStrings: globalPool.strings };
}

/** 解析 RES_PACKAGE_TYPE（0x0200）：拿到类型名、键名两张池，再遍历类型块 */
function parsePackage(buf, start, globalStrings, entries) {
  const headerSize = buf.readUInt16LE(start + 2);
  const chunkSize = buf.readUInt32LE(start + 4);
  if (headerSize < 284) return;
  const pkgId = buf.readUInt32LE(start + 8);
  const typeStringsOff = buf.readUInt32LE(start + 268);
  const keyStringsOff = buf.readUInt32LE(start + 276);
  const typePool = readStringPool(buf, start + typeStringsOff);
  const keyPool = readStringPool(buf, start + keyStringsOff);
  if (!typePool || !keyPool) return;

  let pos = start + headerSize;
  const end = start + chunkSize;
  while (pos + 8 <= end) {
    const type = buf.readUInt16LE(pos);
    const size = buf.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > end) break;
    // 0x0201 = RES_TABLE_TYPE_TYPE，即某个类型在各配置下的取值
    if (type === 0x0201) {
      parseTypeChunk(buf, pos, size, pkgId, typePool.strings, keyPool.strings, globalStrings, entries);
    }
    pos += size;
  }
}

/** 解析一个类型块，把每个资源 ID 对应的取值收进 entries */
function parseTypeChunk(buf, start, chunkSize, pkgId, typeNames, keyNames, globalStrings, entries) {
  const headerSize = buf.readUInt16LE(start + 2);
  const typeId = buf[start + 8];
  const entryCount = buf.readUInt32LE(start + 12);
  const entriesStart = buf.readUInt32LE(start + 16);
  const typeName = typeNames[typeId - 1] || `type${typeId}`;
  const offsetsPos = start + headerSize;
  if (offsetsPos + entryCount * 4 > start + chunkSize) return;

  for (let i = 0; i < entryCount; i += 1) {
    const off = buf.readUInt32LE(offsetsPos + i * 4);
    if (off === 0xffffffff) continue; // 该配置下未定义
    const entryPos = start + entriesStart + off;
    if (entryPos + 16 > start + chunkSize) continue;
    const flags = buf.readUInt16LE(entryPos + 2);
    if (flags & 0x0001) continue; // 复杂资源（状态列表、颜色等）用不到
    const key = buf.readUInt32LE(entryPos + 4);
    const valuePos = entryPos + 8;
    const dataType = buf[valuePos + 3];
    const data = buf.readUInt32LE(valuePos + 4);
    const resId = ((pkgId << 24) | (typeId << 16) | i) >>> 0;

    let slot = entries.get(resId);
    if (!slot) {
      slot = { typeName, key: keyNames[key] || '', values: [] };
      entries.set(resId, slot);
    }
    slot.values.push({ dataType, data, text: dataType === 3 ? globalStrings[data] || '' : '' });
  }
}

/** 图标清晰度排序：xxxhdpi 最优，anydpi（自适应图标）排最后 */
function densityRank(filePath) {
  const match = /(xxxhdpi|xxhdpi|xhdpi|hdpi|mdpi|ldpi)/i.exec(filePath);
  const base = match
    ? { ldpi: 1, mdpi: 2, hdpi: 3, xhdpi: 4, xxhdpi: 5, xxxhdpi: 6 }[match[1].toLowerCase()]
    : 2;
  return /anydpi/i.test(filePath) ? base - 100 : base;
}

/** 在已解析的资源表上做字符串与图片路径查询 */
function makeResolver(resources) {
  const { entries } = resources;

  function resolveString(resId, depth = 0) {
    const slot = entries.get(resId >>> 0);
    if (!slot || depth > 4) return null;
    const direct = slot.values.find((v) => v.dataType === 3 && v.text);
    if (direct) return direct.text;
    // 引用型取值（@string/xxx）再跟一跳
    const ref = slot.values.find((v) => v.dataType === 1);
    return ref ? resolveString(ref.data, depth + 1) : null;
  }

  function resolveImagePath(resId) {
    const candidates = [];
    const push = (slot) => {
      for (const value of slot.values) {
        if (value.dataType === 3 && value.text && IMAGE_RE.test(value.text) && value.text.startsWith('res/')) {
          candidates.push(value.text);
        }
      }
    };
    const primary = entries.get(resId >>> 0);
    if (primary) push(primary);

    if (!candidates.length && primary?.key) {
      // 自适应图标可能只有 XML，用同名资源里找位图兜底
      for (const slot of entries.values()) {
        if (slot.key === primary.key) push(slot);
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => densityRank(b) - densityRank(a));
    return candidates[0];
  }

  return { resolveString, resolveImagePath };
}

/* ------------------------------ 对外接口 ------------------------------ */

/** 清单属性可能是字面量，也可能是 resourceId:0x… 引用，这里统一取出 */
function literalOrRef(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { literal: null, ref: 0 };
  const ref = REF_RE.exec(raw.trim());
  if (ref) return { literal: null, ref: Number.parseInt(ref[1], 16) };
  return { literal: raw.trim(), ref: 0 };
}

/**
 * 读取 APK 的应用名、版本号、包名与图标。
 * @param {string} filePath APK 磁盘路径
 * @returns {Promise<{name:string, version:string, versionCode:number, package:string, icon:{ext:string, buffer:Buffer}|null}|null>}
 */
export async function readApkMeta(filePath) {
  let reader;
  try {
    reader = await ApkReader.open(filePath);
    const manifest = await reader.readManifest();
    const application = manifest.application || {};

    let resolver = null;
    try {
      const table = parseResources(await reader.readContent('resources.arsc'));
      if (table) resolver = makeResolver(table);
    } catch {
      /* 没有资源表时只影响名称与图标的解析 */
    }

    // 应用名：清单 label 优先，取不到再退到启动器 Activity 的 label
    const label = literalOrRef(application.label);
    let name = label.literal || (label.ref && resolver ? resolver.resolveString(label.ref) : '') || '';
    if (!name && Array.isArray(application.activities)) {
      const main = application.activities.find((item) => item.label);
      const fromActivity = literalOrRef(main?.label);
      name = fromActivity.literal || (fromActivity.ref && resolver ? resolver.resolveString(fromActivity.ref) : '') || '';
    }

    // 版本号
    const version = literalOrRef(manifest.versionName);
    const versionName = version.literal || (version.ref && resolver ? resolver.resolveString(version.ref) : '') || '';

    // 图标：资源 ID → 资源表里的位图路径 → 从包内取出字节
    const iconRef = literalOrRef(application.icon);
    let iconPath = null;
    if (iconRef.ref && resolver) iconPath = resolver.resolveImagePath(iconRef.ref);
    else if (iconRef.literal && iconRef.literal.startsWith('res/')) iconPath = iconRef.literal;

    let icon = null;
    if (iconPath) {
      try {
        const buffer = await reader.readContent(iconPath);
        if (buffer?.length) icon = { ext: path.extname(iconPath).toLowerCase() || '.png', buffer };
      } catch {
        /* 取不到图标就留空 */
      }
    }

    return {
      name: String(name).slice(0, 120),
      version: String(versionName).slice(0, 40),
      versionCode: Number(manifest.versionCode) || 0,
      package: String(manifest.package || '').slice(0, 120),
      icon
    };
  } catch {
    return null;
  }
}
