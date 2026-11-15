# config/

Created and used by the Windows app (exe) — nothing here needs to be edited by hand.

| File | What it is |
|---|---|
| `settings.json` | App settings: drum kit map, PC keys, colors, audio calibration, language, last audio source… |
| `browser.log` | Which browser opened the game window (diagnostics) |

The song library lives next to it, in `library/` (one folder per song: `song.json` + `source.gp` / `source.mid`).

Where these folders are:
- **exe:** next to `OpenDrumHero-<version>.exe`. If that folder can't be written (e.g. inside *Program Files*),
  they go to `%APPDATA%\OpenDrumHero`. The environment variable `OPENDRUMHERO_DATA_DIR` chooses another folder.
- **development** (`npm start` in `desktop/`): here, at the root of the repository.

Both folders are in `.gitignore`. If they don't exist, the app starts with an empty library and default
settings and creates them when it saves something. To move your library to another PC, copy `config/` and
`library/` next to the exe there (or export songs with the ⇩ button in the library).

On Android the library and settings stay inside the app (export songs with ⇩ to move them).
