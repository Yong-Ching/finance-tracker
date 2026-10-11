# App icon assets: "Cycle"

Background #111317 · ring #E9E6DF · dot #F2B84B

- svg/: vector sources (square, rounded, circle, mark, mono mark)
- ios/AppIcon.appiconset: drop into Assets.xcassets (Contents.json included). Full-bleed square; iOS applies the mask.
- android/res: copy into app/src/main/res. Adaptive icon (foreground, monochrome, background color) plus legacy and round PNGs. play-store-512.png for the Play Console.
- macos/AppIcon.iconset: run `iconutil -c icns AppIcon.iconset` to build AppIcon.icns. First rename `-2x.png` to `@2x.png` (e.g. `for f in *-2x.png; do mv "$f" "${f/-2x/@2x}"; done`), since iconutil requires the @2x suffix.
- web/: favicon.ico/svg, PNG sizes, apple-touch-icon, webmanifest, head-snippet.html.
- windows/: app.ico and tile PNGs.
- github/: avatar-500.png (Settings > Profile) and social-preview-1280x640.png (Repo Settings > Social preview).
