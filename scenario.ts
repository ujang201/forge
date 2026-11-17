// The suite's seeded scenario, reproduced exactly from wire.ts so the forge can
// answer with the same viewer login the suite expects. Only the user generation
// is needed: the suite creates every repo/issue/PR itself; the forge only needs
// to know who the token belongs to (users[0] is the viewer).
//
// Algorithms (verbatim from program/env/src/wire.ts):
//   SCENARIO_SEED = 0x6a09e667f3bcc909n
//   fnv1a64: offset 0xcbf29ce484222325n, prime 0x100000001b3n, 64-bit mask
//   mix64: splitmix64 finalizer
//   Rng: xorshift64* — x^(x>>12), x^(x<<25), x^(x>>27), * 0x2545f4914f6cdd1dn
//   users: first+last names, login = (first+last) stripped to [a-z0-9-]

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas',
  'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess',
  'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen',
  'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi',
  'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & U64_MASK;
  }
  return h;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  private x: bigint;
  constructor(seed: bigint) {
    this.x = seed === 0n ? SCENARIO_SEED : seed;
  }
  nextU64(): bigint {
    let x = this.x;
    x ^= x >> 12n;
    x ^= (x << 25n) & U64_MASK;
    x ^= x >> 27n;
    this.x = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    const limit = 4294967296 - (4294967296 % maxExclusive);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % maxExclusive;
    }
  }
  pick<T>(list: readonly T[]): T {
    if (list.length === 0) throw new Error('pick from empty list');
    return list[this.nextInt(list.length)];
  }
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The 12 seeded users, in order; users[0] is the viewer. */
export function scenarioUsers(): ScenarioUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const users: ScenarioUser[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let n = 2;
    while (seen.has(login)) {
      login = `${first}${last}-${n}`.replace(/[^a-z0-9-]/g, '');
      n += 1;
    }
    seen.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The login the suite's bearer token names. */
export function viewerLogin(): string {
  return scenarioUsers()[0].login;
}
