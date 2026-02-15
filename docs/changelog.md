# Changelog

## v0.0.1

- Central store as a git repo for AI config files with bidirectional sync using git-based 3-way merge
- Web Admin UI with CodeMirror editor, conflict resolver, and template system
- AI Service Config sync (e.g., `~/.claude/` for Claude Code) with custom service management
- Multi-machine support with `machines.json` for cross-machine sync
- Per-repository settings, ignore patterns, file pattern management, and `.gitignore` management
- File tree with search, right-click actions (delete, ignore), file size indicators
- Clone files/folders across repos with conflict preview
- Store size display with warning indicators and sync blocking threshold
- Update notification from GitHub Releases
- Security hardening: path traversal protection, CORS/host lockdown, symlink validation
- Supported: Claude Code, Cursor, Gemini, GitHub Copilot, Aider, Windsurf
