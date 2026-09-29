# Table artwork: legacy canvases and automatic uploads

The compressed VIP table and smaller dragon table had invisible canvas padding
and/or opaque exterior mattes. Mapping the full file to the seat orbit scaled
that padding too. Upload normalization alone did not repair existing assets.

The client now requests local poker artwork with `tableArt=3`. Before static
delivery, a restricted middleware produces a tightly cropped transparent PNG
using the same normalization as admin uploads. It covers shipped tables, VIP
table sprites, and cosmetics uploads. Original files are preserved. Old clients
and other images keep the ordinary static path. The query version invalidates
old image cache entries; the server deduplicates conversion and retains up to
24 processed responses keyed by source path, size and modification time.

Path prefixes/extensions are allowlisted, traversal and dot paths rejected,
and real paths must remain under the configured asset/upload directory.

Admin uploads retain their automatic orientation correction, bounded resolution,
neutral exterior removal, alpha and tight cropping. Complex opaque backgrounds
are now rejected with an actionable error instead of publishing a rectangle
behind the table. This is deterministic matte cleanup, not arbitrary AI scene
segmentation. The admin page distinguishes raw upload preview from saved,
processed preview and documents the behavior.

Validation: 18 Node tests and 44 Flutter tests passed; admin production build
passed. Delivery tests include the dragon, wolf, Middle Eastern table and all
four VIP tiers, checking transparent corners, removal of square canvas padding,
unchanged originals, cache repeatability and traversal rejection. The catalog
coverage test now recognizes the existing Trix/Tarneeb built-in designs rather
than requiring all of them to be poker themes.

Processed dragon and platinum outputs were visually inspected. No live server
deployment or Android device run performed. Deploy backend and client together
to enable the versioned processing path; deploy the admin build for its updated
preview and instructions.
