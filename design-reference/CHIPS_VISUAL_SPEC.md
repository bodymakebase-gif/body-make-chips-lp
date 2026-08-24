# BODY-MAKE CHIPS visual specification

This file fixes the cumulative appearance rules for the Jerusalem artichoke chips used in LP imagery. Do not discard an older reference when only one aspect is rejected: each reference below has a defined role. `hero-v28-actual-package-color-approved-chips.png` is the sole current approved visual master and must remain unchanged unless the user explicitly approves a replacement.

## Workflow lock

- Never use a generated correction as the edit target for the next correction. Iterative re-rendering caused cumulative drift in surface, colour, thickness and shape.
- The public/LP hero must keep the v28 master. New attempts are comparison references only until the user explicitly approves them.
- If improvement is attempted later, restart from v28 every time and change one variable only. Do not overwrite v28. Use v11 only as the approved chip colour/material reference, the real-product photograph as the physical-shape reference, and `d2332831-4974-401a-a303-3eb88c18e652.png` as the sole pouch colour/material reference.
- Current correction direction: use v11 only as the composition, mood, camera and pouch-placement reference. Use `real-product-chips-source-1.jpeg` as the highest-priority authority for every physical chip property and for the honest 15 g serving volume.
- Latest comparison direction: generate a fresh, fully integrated product photograph instead of repeatedly editing a prior correction. Preserve v11's dark scene and left-side copy space, while matching the real photograph's actual silhouette distribution, size relative to the pouch, thinness, broken-piece ratio, peel irregularity and roasting-colour spread. Do not enlarge, standardise, round or increase the product for advertising impact.

## Shape and thickness

- Current hero-image rule (latest user direction): physical fidelity to the real product takes priority over the earlier round-chip simplification. The hero must reproduce the real photograph's mixture of irregular asymmetric root slices and a limited number of recognisable partial/broken slices. Readability remains required, but it must come from natural overlap, small gaps, edge light and contact shadows rather than turning the product into uniform coins.
- Slices come from an irregular, knobbly Jerusalem artichoke. Most silhouettes are asymmetric and uneven rather than clean round coins.
- Slices are generally very thin, but neither the full batch nor each slice has perfectly uniform thickness.
- A few pieces or local areas may appear slightly thicker.
- Warping belongs to the whole slice. Do not create a decorative ruffle only along the edge.
- Irregular does not mean shredded, collapsed or unidentifiable. Every major piece must still read immediately as one thin sliced chip.
- Every visible piece must read as a chip. A naturally broken partial slice is allowed only when its original chip silhouette remains obvious; anonymous brown fragments, crumbs, shreds, flakes or debris are not allowed.
- Use irregular but coherent root-slice silhouettes with a broad continuous face. Avoid both extremes: tidy repeated coin/flower/star silhouettes and collapsed or amorphous shapes.
- Mix multiple recognisable root-slice silhouettes in the same batch: irregular triangular/pizza-slice-like pieces, Y-shaped or three-armed pieces, asymmetric multi-lobed pieces, lopsided ovals/teardrops and compact irregular polygons. These are silhouette descriptions only; every piece must still look like the same product.

## Colour and heat variation

- Current hero-image rule (latest user direction): keep the real-product-driven shapes and serving volume, but match the chips' visible colour and perceived brightness to `hero-v11-approved-material-reference.png`. The average should be its warm, appetising medium golden tan, with restrained pale-honey and deeper toasted variation. Do not darken the pile as a whole or shift it toward dull beige.
- The locked average colour is the medium golden tan shown in `hero-v11-approved-material-reference.png`.
- A single batch must span a visibly wider range from light honey beige through the golden majority to a small number of deeper toasted ochre/brown pieces, while preserving that average.
- The darker toasted chips are a minority (roughly 5–8%) but must be visibly identifiable at hero-image scale as browned chips, not as dark unidentified matter. Distribute them through the bowl instead of grouping them.
- Adding darker toasted chips must never darken the batch as a whole. Pair the visible area of darker chips with a comparable visible area of lighter honey-beige chips so the original v11 spatially averaged colour and perceived brightness remain unchanged.
- Each slice can contain broad pale, amber and darker zones caused by uneven heat exposure.
- Colour changes must be organic and low-frequency, not an identical dark-centre gradient applied to every slice.

## Surface and skin

- Match the dry, smooth dehydrated surface shown in `hero-v11-approved-material-reference.png`.
- Do not render visible cellular, honeycomb, vascular, maze-like, embossed or decorative surface patterns. At close mobile scale the face should read as mostly smooth and dry, with only restrained natural tonal variation.
- The skin is not a uniform outline. Mix slices with nearly continuous skin, interrupted skin, partly missing skin and very thin skin segments.
- Skin width and apparent thickness also vary within a slice and between slices.

## Scene integration

- Preserve realistic overlap, scale, depth of field, contact shadows and ambient colour from the scene.
- Product pouch, chips, bowl and background must read as one photograph, not separately composited cut-outs.
- Avoid oily gloss, seasoning dust, potato-chip shapes, identical repeated pieces, repeated artificial patterns and uniformly bright chips.
- For any public use of generated serving photography, retain an explicit `盛り付けイメージ` disclosure near the image. Generation can reduce visual mismatch but cannot guarantee that every production batch will look identical.

## Reference roles and approval log

- `hero-v11-approved-material-reference.png`: prior approved material/colour reference. It is byte-for-byte identical to the desktop source `exec-9ccb183d-f689-40bd-b46b-269697c5b21c.png`. Preserve it unchanged, but it is no longer the public LP hero.
- `hero-v12-shape-color-candidate.png`: retained intermediate reference, not a discarded file. It records a partial improvement in shape direction, but texture worsened, darker pieces remained invisible and the overall result is inferior to v11. Do not use it as an LP asset or as a texture/colour master.
- `hero-v13-rejected-drift-reference.png`: negative reference documenting cumulative generation drift. Rejected traits: stronger unwanted cellular pattern; darker average colour; lost thickness variation; insufficient light/dark dispersion; only two or three pieces retain a recognisable chip silhouette. Never use as an edit target or LP asset.
- `hero-v14-shape-variety-candidate.png`: rejected comparison candidate. The silhouette variety produced too many pieces that did not read clearly enough as chips. Keep only as a negative shape reference; do not use it as an LP asset or edit target.
- `hero-v15-round-chip-candidate.png`: unapproved round-chip baseline. Every visible piece was simplified to a round chip silhouette while the original colour direction was held. It is the comparison input for the requested natural-variation study, not an LP asset.
- `hero-v16-round-natural-variation-candidate.png`: rejected comparison candidate. The added peel, bend and silhouette variation did not produce a convincing result. Keep only as a negative reference; do not use it as an LP asset or edit target.
- `hero-v17-edge-definition-candidate.png`: rejected edit-based comparison candidate. Local edge-definition editing did not improve the pile enough. Keep only as a negative reference for the edit-based approach; do not use it as an LP asset or edit target.
- `hero-v18-regenerated-clear-chip-boundaries-candidate.png`: unapproved regenerated baseline created from the v11 composition/material reference, the official pouch source and the real-product photo. The top layer is intentionally less dense so individual chip silhouettes and overlaps remain legible. It is the layout source for v19, not an LP asset.
- `hero-v19-clear-boundaries-approved-material-candidate.png`: prior unapproved comparison candidate. It retains the v18 separated-chip direction while replacing the chip faces with a smoother, quieter dry-matte material and returning the colour toward v11's medium golden-tan range. Keep for comparison only; do not use in the LP.
- `hero-v20-smooth-surface-color-variation-candidate.png`: prior unapproved comparison candidate. It starts from the user-selected smooth, pale, clearly separated chip scene and adds restrained inter-chip baking-colour variation while keeping the average bright and the faces quiet. Keep for comparison only; do not use in the LP.
- `hero-v21-regenerated-clear-chip-boundaries-candidate.png`: prior unapproved newly generated comparison candidate. It uses a reduced, separated top layer so every chip and overlap boundary remains legible, while retaining the dark hero composition and official pouch identity. Keep for comparison only; do not use in the LP.
- `hero-v22-regenerated-clear-irregular-chip-boundaries-candidate.png`: prior unapproved newly generated comparison candidate. It preserves the clearly separated top-layer construction while mixing a controlled share of complete irregular silhouettes instead of repeated round coins. Keep for comparison only; do not use in the LP.
- `hero-v23-regenerated-real-shape-readable-boundaries-candidate.png`: prior unapproved newly generated comparison candidate. Its silhouettes are driven by intact shapes observed in the real-product photo, while the pile is deliberately sparse enough to keep overlaps and boundaries readable. Keep for comparison only; do not use in the LP.
- `hero-v24-hybrid-clear-layout-approved-material-candidate.png`: prior unapproved hybrid comparison candidate generated from the user-selected separated scene and the v11 correct master. It combines the former's chip-by-chip readability with the latter's warmer colour, material direction, shape variation and scene integration. Keep for comparison only; do not use in the LP.
- `hero-v25-correct-master-clear-boundary-candidate.png`: prior unapproved comparison candidate created by re-rendering only the chips in the v11 correct master. Its goal was clearer natural chip-to-chip separation while holding colour, size, material, pile scale, pouch, bowl, background and composition constant. It is not referenced by the LP.
- `hero-v26-real-product-sales-fidelity-candidate.png`: prior unapproved comparison candidate. It keeps v11's dark integrated hero composition and official pouch identity, but treats the real-product photograph as the highest authority for chip silhouette distribution, thinness, scale, peel variation, roasting-colour spread and honest 15 g serving volume. Its chip colour is the baseline adjusted in v27; it is not referenced by the LP.
- `hero-v27-real-shape-approved-color-candidate.png`: previously approved chip/scene master. It preserves v26's real-product-driven chip shapes, thinness, pile volume and scene, while changing only the chip colour and perceived brightness toward v11's approved warm golden-tan appearance. Its pouch ink was too yellow/neon and its black material too glossy, so it is no longer the public master.
- `hero-v28-actual-package-color-approved-chips.png`: current user-approved visual master. It preserves v27's approved chips, bowl, composition and scene while correcting only the pouch toward the physical package reference: neutral matte black with subdued yellow-green ink. The LP uses its desktop pixels as `assets/hero-integrated-v28.png` plus the browser-optimised `assets/hero-integrated-v28.webp`; the mobile assets are non-generative portrait reframes of the same image as `assets/hero-integrated-mobile-v28.png`/`.webp`.
- Do not reuse one finished photograph, crop, bowl or chip pile across multiple LP sections. Use v28 only as the visual quality benchmark; ABOUT, TASTE FIRST and the final CTA must each have a genuinely different camera setup, arrangement and lighting design while remaining faithful to the real-product source.
- `about-integrated-v11`: section-specific upright package-and-bowl composition with copy space on the right. The real pouch artwork remains fully readable.
- `taste-integrated-v11`: section-specific food-only low-angle composition with copy space on the left. No package is used.
- `final-integrated-v11`: section-specific long black serving-board composition with the package at the far right and copy space on the left.
- Feature, ingredient, lineup and story decoration must use CSS light/texture treatments instead of repeating one of the three photographs or extracting chips from it.
- `chips-appearance-reference-v1.png`: historical form experiment only. Useful for asymmetric silhouettes and whole-slice warping. Do not copy its cellular surface pattern, overly tidy edge treatment or uniform piece construction.
- `real-product-chips-source-1.jpeg`: archived real-product photograph. It is the physical truth for natural silhouettes, breakage and batch variation, and overrides generated references when a conflict exists.
