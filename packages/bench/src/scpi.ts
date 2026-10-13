export interface ScpiIO { write(data: Buffer): void; read(): Buffer; }
/** Exclusive request/reply transport. Caller supplies an OS timeout and an outer process deadline. */
export class Scpi {
  constructor(private readonly io: ScpiIO) {}
  write(command: string) {
    if (!command || command.length > 256 || /[\r\n\0]/.test(command)) throw new Error('Invalid SCPI command');
    this.io.write(Buffer.from(command + '\n'));
  }
  queryText(command: string) { return this.query(command, false).toString('ascii').trim(); }
  queryBlock(command: string) { return this.query(command, true); }
  private query(command: string, binary: boolean): Buffer {
    this.write(command);
    let data: Buffer = Buffer.alloc(0);
    for (let reads = 0; reads < 64; reads++) {
      const next = this.io.read();
      if (!next.length) throw new Error('Empty SCPI response');
      data = Buffer.concat([data, next]);
      if (data.length > 4096) throw new Error('SCPI response exceeds bench bound');
      let expected: number | undefined;
      if (binary) {
        if (data[0] !== 35) throw new Error('Expected definite-length SCPI block');
        if (data.length >= 2) {
          const digits = data[1]! - 48;
          if (digits < 1 || digits > 9) throw new Error('Invalid SCPI block length');
          if (data.length >= 2 + digits) {
            const size = data.subarray(2, 2 + digits).toString('ascii');
            if (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 1200) throw new Error('Unsupported SCPI payload length');
            expected = 2 + digits + Number(size) + 1;
          }
        }
      } else {
        const lf = data.indexOf(10);
        if (lf >= 0) expected = lf + 1;
      }
      if (expected !== undefined && data.length >= expected) {
        if (data.length !== expected || data.at(-1) !== 10) throw new Error('SCPI response framing mismatch');
        return data;
      }
    }
    throw new Error('SCPI response read limit exceeded');
  }
}
