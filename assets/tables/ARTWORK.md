# Poker table artwork — 2026-09-28

Generated/edited using the built-in image generation tool, then passed through
the same `normalizeTableArtwork` upload pipeline to trim transparent padding.
Original generated files remain at the tool's save location.

- `arabesque_palace.png`: new emerald, brass, turquoise and lapis table inspired
  by Middle Eastern geometric decorative arts. Catalog name: طاولة قصر الشرق.
  Initial price: 30,000,000 coins. Admin edits to its price are preserved by the
  missing-item catalog insertion.
- `wolf_night_clean.png`: transparent replacement for the old opaque black
  background image. The original `wolf_night.png` remains available in source;
  built-in references and legacy catalog URLs resolve to the clean version.

## Final generation prompt

Create one finished game asset: a complete premium poker table sprite inspired by Middle Eastern decorative arts, named concept 'Arabesque Palace'. Stylized-concept, polished realistic game art. Horizontal oval tabletop, gently elevated top/front perspective, dark emerald felt with a very subtle tonal eight-point-star geometric weave, intricately engraved warm brass rim with turquoise and lapis mosaic inlays inspired by mashrabiya and Damascene craftsmanship. Quiet uncluttered center for playing cards. Entire padded rail and modest front apron visible. Table silhouette approx 2.5:1 width to height, landscape canvas 1600x640 if possible, tightly framed with only 2% transparent margin. ACTUAL transparent alpha background, no black/white backdrop, no floor, no shadow outside silhouette. No room, people, chairs, cards, chips, flags, text, religious symbols, watermark. All outer edges must fit completely in canvas. This is a production PNG sprite to be composited into an existing poker scene. Return saved image asset.

## Final wolf edit prompt

Precise object edit for production game asset. Remove ONLY the flat black exterior background around this existing wolf poker table and replace it with actual transparent alpha. Keep the entire table, blue black padded rail, front apron, wolf artwork and proportions intact; do not cut away the black rail itself. Remove the small empty chair protruding at the top center, replace it with continuation of the existing rail. Crop canvas tightly to the full table's visible bounds with 1% transparent margin, wide horizontal sprite. No floor, backdrop, text, new objects. Preserve existing wolf design and full outer rim.

## Upload behavior

New table uploads remove neutral near-black/near-white edge-connected matte
when the opaque corners agree. Enclosed interior details are preserved. Existing
alpha is retained, transparent margins are trimmed, and empty results are
rejected. Complex or coloured backgrounds are not automatically segmented; use
a transparent PNG for those. The game maps the tight sprite bounds to the full
seat-orbit rectangle without letterboxing or a second perspective tilt.
