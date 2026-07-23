# Stage Mirror

Stage Mirror adds **Restore Working Tree from HEAD** to the right-click menu in VS Code Source Control.

It restores the selected file content in the Working Tree from `HEAD` without changing the staged version.

This is useful when you want to keep your staged changes exactly as they are, but reset the Working Tree copy.

## How it works

Stage Mirror runs:

```text
git -C <repository-root> restore --source=HEAD --worktree -- <file-path>
```

It uses `--worktree` only and does not use `--staged`, so the Git index remains unchanged.

## Example

Suppose `line B` was deleted and the deletion was staged.

Before:

```text
HEAD:
line A
line B

Stage:
line A

Working Tree:
line A
```

After running **Restore Working Tree from HEAD**:

```text
HEAD:
line A
line B

Stage:
line A

Working Tree:
line A
line B
```

The deletion is still staged. Only the Working Tree file is restored.

## Usage

1. Open the VS Code Source Control view.
2. Select one or more files.
3. Right-click the selection.
4. Choose **Restore Working Tree from HEAD**.
5. Confirm the operation.

## Settings

| Setting                               | Default | Description                                                 |
| ------------------------------------- | ------- | ----------------------------------------------------------- |
| `stageMirror.confirmBeforeRestore`    | `true`  | Ask for confirmation before replacing Working Tree changes. |
| `stageMirror.showSuccessNotification` | `true`  | Show a notification after a successful restore.             |

Errors are displayed in a notification and written to the **Stage Mirror** output channel.

## Development

```bash
npm install
npm run compile
npm run lint
```

## Limitations

* Requires Git 2.23 or later.
* Newly added files that do not exist in `HEAD` cannot be restored from `HEAD`.
* Very large selections may exceed the operating system command-length limit.
* Virtual file systems are not supported.
* Git errors such as missing `HEAD`, permission problems, locked files, conflicts, or unsafe repository ownership are shown to the user.

## License

MIT License - see [LICENSE](LICENSE) for details.
