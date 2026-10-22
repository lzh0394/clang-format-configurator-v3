// Minimal ustar reader. Enough for npm tarballs (no GNU long names in the
// paths we extract), avoids pulling a tar dependency into the toolchain.

const BLOCK = 512;

function readString(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

/**
 * @param {Buffer} buf uncompressed tar archive
 * @returns {Map<string, Buffer>} path -> contents
 */
export function untar(buf) {
  const files = new Map();
  let offset = 0;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const sizeField = readString(header, 124, 12).trim();
    const size = Number.parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + BLOCK;

    // 'x' / 'g' are pax extended headers; '5' is a directory.
    if (type === "0" || type === "\0" || type === "") {
      files.set(path, buf.subarray(dataStart, dataStart + size));
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }

  return files;
}
