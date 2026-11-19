# Changelog

## 0.2.0 (2026-11-19)

- Standalone macOS app with a dedicated window and a drag-to-Applications
  disk image for Apple Silicon and Intel Macs.
- Pockets follow the ICP/FBSR regulation: corner noses R1 = 5 mm and a 5.5 mm
  corridor before the ball drops (was a ~25 mm-deep capture inside a 75 mm
  parallel tunnel); side noses R2 = 11 mm with the fall line 5 mm in front of
  the nose line (was 20 mm out on the cloth, which made sides too generous).
- Pot drop is physical: the server sends each ball's exact capture position
  and velocity; the ball rolls over the slate edge, free-falls, hits the
  leather back of the pocket on hard pots, and settles in the net.
- Solid, colored aim line with a ghost ball and a contact-point marker
  (replaces the dashed line whose gaps hid the contact).
- Physics aim preview, backed by `POST /api/predict {target_only: true}`:
  - target-ball path (`T`, cyan) for the first ball the cue ball *physically*
    touches -- squirt/swerve included -- and the ghost ball + contact dot now
    follow that real first contact instead of the straight cue line;
  - cue-ball path (`Y`, pink) so svoyaks, follow/draw and squirt are visible;
    green end ring when a path drops.
  - Refreshes as fast as the server simulates: no debounce, one request in
    flight (latest aim wins), and the simulation stops once the cue ball and
    the touched ball are at rest (~2-15 ms for typical layouts).
- Finer arrow-key aim: 0.02° (Option = 0.005°, Shift = 0.5°); fixed Shift+arrow
  turning the opposite way to the plain arrow.
- Aim-assist prediction now respects the selected cue ball.

## 0.1.0 (2026-10-28)

Initial release.

- 3D view (three.js): orbitable camera, TV angle behind the head rail,
  top-down preset, cloth-plane aiming; 2D view toggle (V).
- 2D layout matches the real table: vertical by default, horizontal toggle.
- 12-foot Russian Pyramid table: 74 mm corner mouths with straight, sharp
  1.5 mm jaws; 82 mm side pockets; validated pot/rattle behavior.
- 68 mm / 285 g balls with pooltool's event-based physics.
- Potted balls roll into the hole and sink below the cloth.
- Aim with spin (english), power, and cue elevation; live ghost-ball preview.
- Optional aim assist showing the full simulated runout.
- Shot playback with trails, cushion ripples, and pot animations.
- **Repeat the same situation** after every shot, with attempt history.
- Built-in drills: free practice, full rack break, corner cuts, side pockets,
  svoyak caroms.
- Cushion physics presets: `tournament` (lively rails) and `research`
  (deadened leather jaws).
