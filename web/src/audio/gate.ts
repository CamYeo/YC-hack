/** Pure monotonic epoch gate. A local interruption rejects old work before the server replies. */
export class PlaybackGate {
  private minimumEpoch = 0
  private seen = new Set<string>()
  accept(id: string, epoch: number): boolean {
    if (epoch < this.minimumEpoch || this.seen.has(id)) return false
    this.minimumEpoch = Math.max(this.minimumEpoch, epoch)
    this.seen.add(id)
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value ?? '')
    return true
  }
  advance(epoch: number): void { this.minimumEpoch = Math.max(this.minimumEpoch, epoch) }
  interrupt(epoch = this.minimumEpoch): void { this.advance(epoch + 1) }
  allows(epoch: number): boolean { return epoch >= this.minimumEpoch }
}
