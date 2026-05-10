export type LoopDetectorState = 'normal' | 'warning' | 'force_give_up';

export class LoopDetector {
  private window: string[] = [];
  private readonly maxWindow = 20;

  record(digest: string): LoopDetectorState {
    this.window.push(digest);
    if (this.window.length > this.maxWindow) this.window.shift();

    let runLength = 1;
    for (let i = this.window.length - 2; i >= 0; i--) {
      if (this.window[i] === digest) runLength++;
      else break;
    }
    if (runLength >= 5) return 'force_give_up';
    if (runLength >= 3) return 'warning';
    return 'normal';
  }
}
