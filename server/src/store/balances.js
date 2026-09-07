export class BalanceStore {
  constructor(startingBalanceCents) {
    this.startingBalanceCents = startingBalanceCents;
    /** @type {Map<string, number>} */
    this.balances = new Map();
  }

  get(userId) {
    if (!this.balances.has(userId)) {
      this.balances.set(userId, this.startingBalanceCents);
    }
    return this.balances.get(userId);
  }

  debit(userId, cents) {
    const current = this.get(userId);
    if (cents <= 0 || current < cents) return false;
    this.balances.set(userId, current - cents);
    return true;
  }

  credit(userId, cents) {
    if (cents <= 0) return this.get(userId);
    const next = this.get(userId) + cents;
    this.balances.set(userId, next);
    return next;
  }
}
