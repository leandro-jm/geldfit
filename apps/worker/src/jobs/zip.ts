import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { createInterface } from 'node:readline';

/** Lê as linhas do primeiro arquivo de um .zip em memória, descompactando em streaming. */
export async function* zipLines(buf: Buffer, encoding: BufferEncoding = 'latin1'): AsyncGenerator<string> {
  // End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip inválido');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('diretório central inválido');
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compSize);
  const source = Readable.from([data]);
  const stream = method === 8 ? source.pipe(createInflateRaw()) : source;
  stream.setEncoding?.(encoding);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}
