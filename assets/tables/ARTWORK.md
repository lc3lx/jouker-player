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

## Emerald Club — Trix / Tarneeb (2026-09-29)

Generated using the built-in imagegen tool, then normalized with the existing table-art transparency/crop pipeline. Shared free default; a separate second generation was blocked by the image tool usage limit.

Saved assets:
- backend/assets/tables/emerald_club.png
- frontapp/assets/images/card_tables/emerald_club.png
- Rendered verification: frontapp/build/previews/rect-card-table.png

Prompt:
> Production card-game table sprite for Tarneeb. One complete rounded-rectangle table, near-orthographic top view, portrait aspect 4:5, canvas 1024x1280. Sophisticated international luxury club style: deep emerald billiard felt with subtle fine weave, padded forest-green leather rail, thin brushed champagne brass inlay and restrained geometric corner engraving. Spacious calm empty center, symmetric four sides for four players. No objects on table, no text, cards, chips, cupholders, people, chairs, legs or room. Entire rail inside frame, very small transparent margin. TRUE transparent alpha exterior, no black background or drop shadow. Crisp refined game-ready realistic material rendering. Rail about 9 percent of width. Attractive premium understated visual, not busy. Save final PNG.

## Dubai Nights and Damascus Mosaic — 2026-09-29

Mode: built-in imagegen. Saved final transparent PNGs through normalizeTableArtwork:
- backend/assets/tables/dubai_nights.png; bundled copy frontapp/assets/images/card_tables/dubai_nights.png. Price: 30,000,000.
- backend/assets/tables/damascus_mosaic.png; bundled copy frontapp/assets/images/card_tables/damascus_mosaic.png. Price: 20,000,000.
Both are for Trix and Tarneeb. Existing catalogs insert missing items without overwriting admin edits. Assets and changes are local, not deployed.

Dubai prompt:
> Generate a production game asset: one complete luxury Dubai themed card table sprite for four-player Tarneeb and Trix. Portrait 4:5 rounded rectangle, top-down orthographic view, entire table and rail fully inside frame. Deep midnight navy felt with quiet empty center, champagne gold metal and elegant dark blue padded leather rail about 9% of width. Delicate Dubai skyline-inspired gold inlay concentrated on top and bottom rail, tall spired modern skyscraper motif and sail-shaped architecture, sophisticated contemporary Dubai luxury. Restrained decoration, realistic refined materials, crisp mobile game art. TRUE transparent alpha background outside table, tiny exterior margin, no black rectangle, no shadows outside. No room, chairs, people, cards, chips, buttons, text or watermark. Output PNG.

Damascus prompt:
> Production mobile card game asset: one complete DAMASCUS themed four-player Trix / Tarneeb table sprite, top-down orthographic view, portrait 4:5 rounded rectangle. Entire padded rail inside canvas with small safe transparent margin. Beautiful authentic Damascus craftsmanship: walnut wood and mother-of-pearl mosaic marquetry geometric stars around rail, restrained ivory and turquoise inlay, deep rich burgundy velvet felt quiet spacious EMPTY center. Small elegant jasmine floral motifs at corners. Luxurious realistic crafted materials, refined international premium game art. Rail about 9% of width. TRUE transparent alpha exterior. All decorations integrated into rail, nothing protruding outside silhouette. No room, people, chairs, cards, chips, buttons, text, watermark, external shadow or black rectangular background. PNG.
