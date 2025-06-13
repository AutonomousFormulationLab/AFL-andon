# Code Signing Certificates

This project uses Electron Builder to produce installer packages. Signing the
packages requires certificate files and corresponding passwords. These files are
not stored in the repository. Instead, they can be added later through GitHub
Actions secrets.

## Adding Certificates

1. Convert your signing certificates to base64 strings so they can be stored as
   secrets. For example:
   ```bash
   base64 -w0 path/to/cert.p12 > cert.p12.b64
   ```
2. In the GitHub repository, navigate to **Settings** ➜ **Secrets and
   variables** ➜ **Actions**.
3. Create secrets for each certificate and password, e.g.:
   - `WIN_CERT` – the base64 string of the Windows `.p12` file
   - `WIN_CERT_PASSWORD` – the password for the `.p12`
   - `MAC_CERT` – the base64 string of the macOS `.p12` file
   - `MAC_CERT_PASSWORD` – the password for the `.p12`

## Using Secrets in the Workflow

In `.github/workflows/build.yml`, add steps before the build to decode the
secrets and use them for signing. Example:

```yaml
- name: Set up code signing certificates
  run: |
    echo "$WIN_CERT" | base64 --decode > win_cert.p12
    echo "$MAC_CERT" | base64 --decode > mac_cert.p12
  shell: bash
  env:
    WIN_CERT: ${{ secrets.WIN_CERT }}
    MAC_CERT: ${{ secrets.MAC_CERT }}
```

Then configure `electron-builder` via environment variables or the
`package.json` `build` section to reference these certificate files and
passwords. Refer to the Electron Builder documentation for detailed options.
