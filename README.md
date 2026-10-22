# Pinned workspace navigation QA

Renderer source: a3cdcd0be766760970bab462b7b5f7976d55915f.

These screenshots contain isolated test fixtures, not production workspace contents.

- cross-host-hierarchy.png: two real isolated daemons deliberately share a bare workspace ID; host-qualified parent and child remain distinct, with 16px indentation and ordinary project rows flat.
- nesting-target.png: named cross-project nesting preview.
- cycle-blocked.png: descendant cycle refused before persistence.
- alphabetical-drag.png: A-Z drag captures visible order as persisted manual order.

146 focused unit tests and all ten sidebar browser cases passed. Native device testing is not claimed. macOS package smoke evidence will be added after the immutable artifact is built.
