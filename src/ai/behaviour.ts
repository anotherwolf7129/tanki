export type Status = 'success' | 'failure' | 'running';

export interface Node<B> {
  readonly name: string;
  tick(bb: B, dt: number): Status;
}

/** Runs children in order until one succeeds or is running. */
export function selector<B>(name: string, children: Node<B>[]): Node<B> {
  return {
    name,
    tick(bb, dt) {
      for (const child of children) {
        const s = child.tick(bb, dt);
        if (s !== 'failure') return s;
      }
      return 'failure';
    },
  };
}

/** Runs children in order until one fails or is running. */
export function sequence<B>(name: string, children: Node<B>[]): Node<B> {
  return {
    name,
    tick(bb, dt) {
      for (const child of children) {
        const s = child.tick(bb, dt);
        if (s !== 'success') return s;
      }
      return 'success';
    },
  };
}

export function condition<B>(name: string, fn: (bb: B) => boolean): Node<B> {
  return { name, tick: (bb) => (fn(bb) ? 'success' : 'failure') };
}

export function action<B>(name: string, fn: (bb: B, dt: number) => Status): Node<B> {
  return { name, tick: fn };
}

/** Gate that only lets the subtree run when the predicate holds. */
export function guard<B>(name: string, fn: (bb: B) => boolean, child: Node<B>): Node<B> {
  return {
    name,
    tick(bb, dt) {
      return fn(bb) ? child.tick(bb, dt) : 'failure';
    },
  };
}
