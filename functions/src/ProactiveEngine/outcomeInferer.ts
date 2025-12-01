import { RowState } from './types';

export class OutcomeInferer {
  private static approx(x: number, y: number, tol: number = 0.6): boolean {
    return Math.abs(x - y) <= tol;
  }

  static toLevelIndex(martingalaUi: number): number {
    if (martingalaUi >= 1 && martingalaUi <= 8) {
      return martingalaUi - 1;
    }
    return Math.max(Math.min(martingalaUi, 7), 0);
  }

  static inferOutcome(s: RowState, levelIdxNow: number, margineNow: number): string {
    if (s.prevMazzo === null) return 'T';
    
    const dM = margineNow - s.prevMargine;
    const dL = levelIdxNow - s.prevLevel;
    
    if (this.approx(dM, 0) && dL === 0) return 'T';
    if ((levelIdxNow === 0 || dL < 0) && this.approx(dM, +s.prevStake)) return 'B';
    if (dL >= 1 && this.approx(dM, -s.prevStake)) return 'P';
    if (dL > 0) return 'P';
    if (dL < 0 || levelIdxNow === 0) return 'B';
    
    return 'T';
  }
}
