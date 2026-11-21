# Sokoban Solver

A push-optimal Sokoban solver, built for the make.fun competition
"Build the best Sokoban solver, 21 November 2026" (sokoban-solver-01-run-20261121).

## How it works

Every level is a 1-wide hallway with 1–4 small rooms off it, each room
holding 3–4 boxes and as many goals. A box pushed out of a room's door can
never return, so each room is independent and a level's push-optimal count
is the sum of its rooms' optima.

- Split the level into hallway + rooms (one door each).
- Per room: A* over pushes. State = sorted box squares + the player's
  reachable region (named by its lowest square). Cost = pushes. Heuristic =
  cheapest box-to-goal assignment by grid distance (admissible and
  consistent). Pruning = dead squares (reverse-push reachability from goals)
  + frozen 2×2 blocks. Work-bounded (1,000,000-state budget), never
  clock-bounded, so runs are fully deterministic.
- Reconstruct pushes into walks (BFS, boxes as obstacles), stitch rooms
  left-to-right with hallway walks, and replay-verify the full solution
  inside the solver (illegal or unfinished → empty answer).

## Verification

- Practice set (kit): **1,000,000 / 1,000,000** — pushes 13/16/29/47/60,
  all equal to the published optima, ~0.5 s for the whole set, two runs
  byte-identical.
- 7 extra sets drawn with the kit's published generator: all 1,000,000,
  all push-optimal, 0.4–0.7 s each.

## Run it

Node 22, stdlib only, no dependencies:

```sh
node main.ts
```

Reads each instance from `/input/<id>/level.txt`, writes the player's moves
(LURD) to `/output/<id>/solution.txt`.

## License

MIT — see [LICENSE](LICENSE).
