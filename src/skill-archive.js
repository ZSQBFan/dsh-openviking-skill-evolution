// ZIP storage without compression. OpenViking receives a complete package on PUT.
const crcTable = Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ (i & 1 ? 0xedb88320 : 0);
  return i;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export function validPackagePath(path) {
  return typeof path === 'string' && path.length <= 512 && path.split('/').every(part =>
    part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f\x7f]/.test(part));
}

export function skillArchive({ body, files, metadata }) {
  const items = [['SKILL.md', Buffer.from(body)]];
  for (const [path, base64] of Object.entries(files)) {
    if (!validPackagePath(path) || path.toLowerCase() === 'skill.md') throw Error('Invalid skill attachment path');
    items.push([path, Buffer.from(base64, 'base64')]);
  }
  for (const path of metadata.directories ?? []) {
    if (!validPackagePath(path) || path.toLowerCase() === 'skill.md') throw Error('Invalid skill directory path');
    items.push([`${path}/`, Buffer.alloc(0)]);
  }
  if (items.length > 256 || items.reduce((total, [, data]) => total + data.length, 0) > 16 * 1024 * 1024) {
    throw Error('Skill package exceeds supported archive limits');
  }
  const local = [];
  const central = [];
  let offset = 0;
  let centralLength = 0;
  for (const [name, data] of items) {
    const path = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(path.length, 26);
    local.push(header, path, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    if (name.endsWith('/')) entry.writeUInt32LE(0x10, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, path);
    offset += header.length + path.length + data.length;
    centralLength += entry.length + path.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
