// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
// One program answers all 5 instances of a set in one run.
//
// Idea (from the level structure the competition publishes): every level is a
// 1-wide hallway with 1-4 small rooms off it, each room holding 3-4 boxes and
// as many goals behind a single door. A box pushed out of a door can never
// come back, so the rooms are independent: the level's push-optimal count is
// the sum of the rooms' optima. This program splits each level into its rooms,
// solves every room push-optimally on its own, and stitches the room
// solutions together with walks along the hallway.
//
// A room is solved with A* over pushes. A state is the boxes' squares plus
// the player's reachable region (named by its lowest square). A step costs
// one push. The estimate is the cheapest assignment of boxes to goals by
// grid distance (each push moves one box one square, so it never overstates).
// Two prunings keep the search small, both safe (they never cut a solvable
// state): a box on a dead square (no push path, ignoring the other boxes,
// brings it to any goal) and a box in a frozen 2x2 block of walls and boxes
// with a box off its goal. The search is bounded by work (a state budget),
// never by the clock, and every tie is broken by a fixed order, so two runs
// write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: [dx, dy, letter]. Fixed order everywhere, so ties are stable.
const DIRS: Array<[number, number, string]> = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

// The most states one room search keeps before it gives up (work, not time).
const STATE_BUDGET = 1_000_000;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Level {
  const rows: string[] = text.split('\n').filter((r: string): boolean => r.length > 0);
  const h: number = rows.length;
  const w: number = Math.max(...rows.map((r: string): number => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row: string, y: number): void => {
    for (let x = 0; x < row.length; x++) {
      const ch: string = row[x] as string;
      const i: number = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  goals.sort((a: number, b: number): number => a - b);
  boxes.sort((a: number, b: number): number => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Breadth-first distances from one start over the floor cells, ignoring
// boxes. -1 where unreachable.
function bfsDist(w: number, wall: Uint8Array, floor: Uint8Array, from: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue: number[] = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p: number = queue[qi] as number;
    const d: number = dist[p] as number;
    for (const [dx, dy] of DIRS) {
      const q: number = p + dy * w + dx;
      if (floor[q] && dist[q] < 0) {
        dist[q] = d + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

// A walk (no pushes) from `from` to `to` over floor cells, treating the
// boxes as walls. Returns the move letters, or null when unreachable.
function walk(
  w: number,
  floor: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(floor.length).fill(-1);
  const prevMove: string[] = new Array(floor.length).fill('');
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p: number = queue[qi] as number;
    for (const [dx, dy, letter] of DIRS) {
      const q: number = p + dy * w + dx;
      if (!floor[q] || occupied[q] || prev[q] >= 0) continue;
      prev[q] = p;
      prevMove[q] = letter;
      if (q === to) {
        let moves = '';
        for (let t = q; t !== from; t = prev[t] as number) moves = (prevMove[t] as string) + moves;
        return moves;
      }
      queue.push(q);
    }
  }
  return null;
}

// The squares from which a box alone can be pushed onto some goal: pull the
// goals backwards over open floor (a box on a square y can be pushed to x
// when the player can stand behind it, at y - d, to push it along d).
function liveSquares(w: number, floor: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(floor.length);
  const queue: number[] = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x: number = queue[qi] as number;
    for (const [dx, dy] of DIRS) {
      const d: number = dy * w + dx;
      const y: number = x - d;
      if (floor[y] && floor[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// All permutations of [0..n-1], for the assignment estimate (n <= 4).
function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  const used: boolean[] = new Array(n).fill(false);
  const cur: number[] = [];
  const rec = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

type Room = {
  cells: number[]; // floor cells of the room (door cell included)
  door: number; // the room cell opening onto the hallway
  hall: number; // the hallway cell outside the door (player entry/exit)
  boxes: number[];
  goals: number[];
};

// Split a level into its rooms: the hallway is the player's row; every
// other floor region is one room with one door onto the hallway.
function findRooms(level: Level): Room[] {
  const { w, h, wall, goals, boxes, player } = level;
  const hallRow: number = Math.floor(player / w);
  const inHall: Uint8Array = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i: number = hallRow * w + x;
    if (!wall[i]) inHall[i] = 1;
  }
  const goalSet = new Set(goals);
  const boxSet = new Set(boxes);
  const seen = new Uint8Array(wall.length);
  const rooms: Room[] = [];
  for (let start = 0; start < wall.length; start++) {
    if (wall[start] || inHall[start] || seen[start]) continue;
    // Flood one connected region of non-hallway floor.
    const cells: number[] = [start];
    seen[start] = 1;
    for (let i = 0; i < cells.length; i++) {
      const p: number = cells[i] as number;
      for (const [dx, dy] of DIRS) {
        const q: number = p + dy * w + dx;
        if (!wall[q] && !inHall[q] && !seen[q]) {
          seen[q] = 1;
          cells.push(q);
        }
      }
    }
    cells.sort((a: number, b: number): number => a - b);
    const cellSet = new Set(cells);
    // The door: the room cell beside a hallway cell (lowest first).
    let door = -1;
    let hall = -1;
    for (const c of cells) {
      for (const [dx, dy] of DIRS) {
        const q: number = c + dy * w + dx;
        if (inHall[q]) {
          door = c;
          hall = q;
          break;
        }
      }
      if (door >= 0) break;
    }
    if (door < 0) continue; // a sealed pocket: not a room, leave it alone
    rooms.push({
      cells,
      door,
      hall,
      boxes: cells.filter((c: number): boolean => boxSet.has(c)),
      goals: cells.filter((c: number): boolean => goalSet.has(c)),
    });
  }
  // Left to right by door column: the order the player visits them in.
  rooms.sort((a: number, b: number): number => a.door - b.door);
  return rooms;
}

// Solve one room push-optimally. The player starts on `hall` (the hallway
// cell outside the door) and, when `mustExit`, must end able to walk back out
// to it. Returns the room's moves (starting and ending at `hall`), or null.
function solveRoom(level: Level, room: Room, mustExit: boolean): string | null {
  const { w, wall } = level;
  const floor = new Uint8Array(wall.length);
  for (const c of room.cells) floor[c] = 1;
  floor[room.hall] = 1;
  const n: number = room.boxes.length;
  if (n === 0) return '';
  if (n !== room.goals.length) return null;
  const goalSet = new Set(room.goals);
  const live: Uint8Array = liveSquares(w, floor, room.goals);
  for (const b of room.boxes) if (!live[b]) return null;

  // Grid distance from each goal to every floor cell, ignoring boxes.
  const distToGoal: Int32Array[] = room.goals.map((g: number): Int32Array => bfsDist(w, wall, floor, g));
  const perms: number[][] = permutations(n);
  const hCache = new Map<string, number>();
  const estimate = (bs: number[]): number => {
    const key: string = bs.join(',');
    const hit: number | undefined = hCache.get(key);
    if (hit !== undefined) return hit;
    let best: number = Infinity;
    for (const perm of perms) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const d: number = distToGoal[perm[i] as number]?.[bs[i] as number] as number;
        if (d < 0) {
          ok = false;
          break;
        }
        sum += d;
      }
      if (ok && sum < best) best = sum;
    }
    hCache.set(key, best);
    return best;
  };

  // The player's reachable region from a square, boxes in the way: the
  // region as a mark array, and its lowest square (the state's name for it).
  const region = (occupied: Uint8Array, from: number): { low: number; mark: Uint8Array } => {
    const mark = new Uint8Array(wall.length);
    const stack: number[] = [from];
    mark[from] = 1;
    let low: number = from;
    while (stack.length > 0) {
      const p: number = stack.pop() as number;
      if (p < low) low = p;
      for (const [dx, dy] of DIRS) {
        const q: number = p + dy * w + dx;
        if (floor[q] && !occupied[q] && !mark[q]) {
          mark[q] = 1;
          stack.push(q);
        }
      }
    }
    return { low, mark };
  };

  const startBoxes: number[] = [...room.boxes].sort((a: number, b: number): number => a - b);
  const startOcc = new Uint8Array(wall.length);
  for (const b of startBoxes) startOcc[b] = 1;
  const startRegion = region(startOcc, room.hall);
  if (estimate(startBoxes) === Infinity) return null;

  // A* over pushes. Heap entries: [f, -g, sequence, state id].
  const sBoxes: number[][] = [startBoxes];
  const sCanon: number[] = [startRegion.low];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sPushBox: number[] = [-1];
  const sPushDir: number[] = [-1];
  const bestG = new Map<string, number>();
  const stateKey = (bs: number[], canon: number): string => bs.join(',') + '|' + canon;
  bestG.set(stateKey(startBoxes, startRegion.low), 0);
  const heap: Array<[number, number, number, number]> = [];
  let seq = 0;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i: number = heap.length;
    heap.push(e);
    while (i > 0) {
      const p: number = (i - 1) >> 1;
      if (!heapLess(heap[i] as [number, number, number, number], heap[p] as [number, number, number, number])) break;
      const tmp = heap[i] as [number, number, number, number];
      heap[i] = heap[p] as [number, number, number, number];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top: [number, number, number, number] = heap[0] as [number, number, number, number];
    const last: [number, number, number, number] = heap.pop() as [number, number, number, number];
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c: number = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1] as [number, number, number, number], heap[c] as [number, number, number, number])) c++;
        if (!heapLess(heap[c] as [number, number, number, number], heap[i] as [number, number, number, number])) break;
        const tmp = heap[i] as [number, number, number, number];
        heap[i] = heap[c] as [number, number, number, number];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };
  heapPush([estimate(startBoxes), 0, seq++, 0]);

  const sortedGoals: number[] = [...room.goals].sort((a: number, b: number): number => a - b);
  const sameBoxes = (bs: number[]): boolean => {
    for (let i = 0; i < n; i++) if (bs[i] !== sortedGoals[i]) return false;
    return true;
  };
  // A frozen 2x2: four squares of walls and boxes holding a box off goal.
  const frozen = (occ: Uint8Array, t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b: number = a + 1;
      const c: number = a + w;
      const d: number = c + 1;
      if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[c] || occ[c]) || !(wall[d] || occ[d])) continue;
      if ((occ[a] && !goalSet.has(a)) || (occ[b] && !goalSet.has(b)) || (occ[c] && !goalSet.has(c)) || (occ[d] && !goalSet.has(d))) return true;
    }
    return false;
  };

  let expanded = 0;
  let goalState = -1;
  while (heap.length > 0 && expanded < STATE_BUDGET) {
    const [, negG, , s] = heapPop();
    const g: number = -negG;
    const bs: number[] = sBoxes[s] as number[];
    if (bestG.get(stateKey(bs, sCanon[s] as number)) !== g) continue;
    if (sameBoxes(bs)) {
      // Solved: the player must still be able to walk back out to the hall.
      const occ = new Uint8Array(wall.length);
      for (const b of bs) occ[b] = 1;
      const reg = region(occ, sCanon[s] as number);
      if (!mustExit || reg.mark[room.hall]) {
        goalState = s;
        break;
      }
      // Otherwise keep searching: another way in may leave the exit open.
    }
    expanded++;
    const occ = new Uint8Array(wall.length);
    for (const b of bs) occ[b] = 1;
    const reg = region(occ, sCanon[s] as number);
    for (let bi = 0; bi < n; bi++) {
      const b: number = bs[bi] as number;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di] as [number, number, string];
        const d: number = dy * w + dx;
        const stance: number = b - d;
        if (!reg.mark[stance]) continue;
        const t: number = b + d;
        if (!floor[t] || occ[t] || !live[t]) continue;
        const nb: number[] = [...bs];
        nb[bi] = t;
        nb.sort((a: number, b: number): number => a - b);
        const nOcc = new Uint8Array(wall.length);
        for (const x of nb) nOcc[x] = 1;
        if (frozen(nOcc, t)) continue;
        const h: number = estimate(nb);
        if (h === Infinity) continue;
        const nCanon: number = region(nOcc, b).low;
        const key: string = stateKey(nb, nCanon);
        const known: number | undefined = bestG.get(key);
        if (known !== undefined && known <= g + 1) continue;
        bestG.set(key, g + 1);
        const id: number = sBoxes.length;
        sBoxes.push(nb);
        sCanon.push(nCanon);
        sG.push(g + 1);
        sParent.push(s);
        sPushBox.push(b);
        sPushDir.push(di);
        heapPush([g + 1 + h, -(g + 1), seq++, id]);
      }
    }
  }
  if (goalState < 0) return null;

  // The push list, start to finish.
  const pushes: Array<[number, number]> = [];
  for (let s = goalState; s > 0; s = sParent[s] as number) {
    pushes.push([sPushBox[s] as number, sPushDir[s] as number]);
  }
  pushes.reverse();

  // Turn the pushes into moves: walk to each stance, then push; at the end
  // walk back out to the hallway cell.
  let moves = '';
  let player: number = room.hall;
  const cur: number[] = [...startBoxes];
  const curOcc = new Uint8Array(wall.length);
  for (const b of cur) curOcc[b] = 1;
  for (const [b, di] of pushes) {
    const [dx, dy, letter] = DIRS[di] as [number, number, string];
    const d: number = dy * w + dx;
    const stance: number = b - d;
    const leg: string | null = walk(w, floor, curOcc, player, stance);
    if (leg === null) return null;
    moves += leg + letter;
    player = b;
    const at: number = cur.indexOf(b);
    cur[at] = b + d;
    cur.sort((a: number, b: number): number => a - b);
    curOcc[b] = 0;
    curOcc[b + d] = 1;
  }
  if (mustExit) {
    const out: string | null = walk(w, floor, curOcc, player, room.hall);
    if (out === null) return null;
    moves += out;
  }
  return moves;
}

// Replay a move string on a level: legal, and how many pushes it took.
function replay(
  level: Level,
  moves: string,
): { solved: boolean; pushes: number } | null {
  const { w, wall, goals } = level;
  const boxes: number[] = [...level.boxes];
  let player: number = level.player;
  let pushes = 0;
  const goalSet = new Set(goals);
  for (const ch of moves) {
    const lower: string = ch.toLowerCase();
    const dir: [number, number, string] | undefined = DIRS.find(
      ([, , letter]: [number, number, string]): boolean => letter === lower,
    );
    if (dir === undefined) return null;
    const [dx, dy] = dir;
    const d: number = dy * w + dx;
    const q: number = player + d;
    if (wall[q]) return null;
    const at: number = boxes.indexOf(q);
    if (at >= 0) {
      const t: number = q + d;
      if (wall[t] || boxes.includes(t)) return null;
      boxes[at] = t;
      pushes++;
    }
    player = q;
  }
  boxes.sort((a: number, b: number): number => a - b);
  const solved: boolean =
    boxes.length === goals.length && boxes.every((b: number): boolean => goalSet.has(b));
  return { solved, pushes };
}

function solveLevel(text: string): string {
  const level: Level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const rooms: Room[] = findRooms(level);
  const roomBoxes: number = rooms.reduce((a: number, r: Room): number => a + r.boxes.length, 0);
  // The whole level is rooms: solve each, stitch with hallway walks.
  if (rooms.length > 0 && roomBoxes === level.boxes.length) {
    let moves = '';
    let player: number = level.player;
    const boxes: number[] = [...level.boxes];
    const floorAll = new Uint8Array(level.wall.length);
    for (let i = 0; i < floorAll.length; i++) if (!level.wall[i]) floorAll[i] = 1;
    for (const room of rooms) {
      const occ = new Uint8Array(level.wall.length);
      for (const b of boxes) occ[b] = 1;
      const leg: string | null = walk(level.w, floorAll, occ, player, room.hall);
      if (leg === null) return '';
      moves += leg;
      player = room.hall;
      const roomMoves: string | null = solveRoom(level, room, true);
      if (roomMoves === null) return '';
      moves += roomMoves;
      // The room's boxes are on its goals now; the player is back at its hall.
      for (let i = 0; i < boxes.length; i++) {
        if (room.boxes.includes(boxes[i] as number)) boxes[i] = room.goals[room.boxes.indexOf(boxes[i] as number)] as number;
      }
      boxes.sort((a: number, b: number): number => a - b);
    }
    const check: { solved: boolean; pushes: number } | null = replay(level, moves);
    if (check === null || !check.solved) return '';
    return moves;
  }
  // No room structure (not expected for this competition): one whole-level
  // push search with the same room machinery, player as the entry.
  if (level.boxes.length <= 4) {
    const whole: Room = {
      cells: (() => {
        const cs: number[] = [];
        for (let i = 0; i < level.wall.length; i++) if (!level.wall[i]) cs.push(i);
        return cs;
      })(),
      door: level.player,
      hall: level.player,
      boxes: [...level.boxes],
      goals: [...level.goals],
    };
    const m: string | null = solveRoom(level, whole, false);
    if (m === null) return '';
    const check: { solved: boolean; pushes: number } | null = replay(level, m);
    if (check === null || !check.solved) return '';
    return m;
  }
  return '';
}

for (const id of readdirSync(I).sort()) {
  const moves: string = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
