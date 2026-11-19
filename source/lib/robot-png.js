'use strict';
const { deflateSync } = require('node:zlib');
const crcTable = Array.from({ length: 256 }, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = (i >>> 1) ^ ((i & 1) ? 0xedb88320 : 0);
  return i >>> 0;
});
function chunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  let crc = 0xffffffff;
  for (const bytes of [type, data]) for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, type, data, checksum]);
}
function encodeRobotPng({ width, height, byteWidth, bytesPerPixel, image }) {
  if (![width, height, byteWidth, bytesPerPixel].every(Number.isSafeInteger) || width <= 0 || height <= 0 ||
    ![3, 4].includes(bytesPerPixel) || byteWidth < width * bytesPerPixel || !Buffer.isBuffer(image) ||
    byteWidth * height > image.length) throw new Error('Invalid robotjs bitmap.');
  const stride = 1 + width * 3, rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * byteWidth + x * bytesPerPixel, dest = y * stride + 1 + 3 * x;
      rows[dest] = image[src + 2]; rows[dest + 1] = image[src + 1]; rows[dest + 2] = image[src];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR',header), chunk('IDAT',deflateSync(rows)), chunk('IEND',Buffer.alloc(0))]);
}
module.exports = { encodeRobotPng };
