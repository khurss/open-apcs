/** Elapsed-time sampled engineering model: ambient 20 C, heated equilibrium 40 C, time constant 20 s. */
export class ThermalModel {
  private last: number | null = null;
  private temperature = 20;
  private heating = false;
  step(nowMs: number, heating: boolean): number {
    if (!Number.isFinite(nowMs) || nowMs < 0 || (this.last !== null && nowMs < this.last)) throw new Error('Invalid model time');
    if (typeof heating !== 'boolean') throw new Error('Invalid heater state');
    const elapsed = this.last === null ? 0 : nowMs - this.last;
    if (elapsed > 2500) throw new Error('Virtual process sampling is overdue');
    const equilibrium = this.heating ? 40 : 20;
    this.temperature = equilibrium + (this.temperature - equilibrium) * Math.exp(-elapsed / 20000);
    this.last = nowMs; this.heating = heating;
    return this.temperature;
  }
}
