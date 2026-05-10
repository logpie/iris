import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { type TraceEvent, TraceEventSchema } from './schema.js';

export class TraceWriter {
  private handle: FileHandle | null = null;
  private opening: Promise<FileHandle> | null = null;

  constructor(private readonly path: string) {}

  private async getHandle(): Promise<FileHandle> {
    if (this.handle) return this.handle;
    if (!this.opening) {
      this.opening = open(this.path, 'a');
    }
    this.handle = await this.opening;
    return this.handle;
  }

  async append(event: TraceEvent): Promise<void> {
    const validated = TraceEventSchema.parse(event);
    const line = `${JSON.stringify(validated)}\n`;
    const fh = await this.getHandle();
    await fh.write(line);
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.sync();
      await this.handle.close();
      this.handle = null;
      this.opening = null;
    }
  }
}
