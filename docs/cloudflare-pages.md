# Cloudflare Pages Deploy

This site is ready for a Cloudflare Pages direct upload deployment.

## Project details

- Project name: `memories-2-dvd-usb`
- Output directory: project root `.`
- Config file: `wrangler.toml`
- Deploy type: static site, no build step required

## Dashboard path

1. Log in to Cloudflare.
2. Open Workers & Pages.
3. Select Create application.
4. Choose Pages.
5. Choose Direct Upload.
6. Use project name `memories-2-dvd-usb`.
7. Upload the full project folder contents.

## Notes

- This project is a plain static site, so there is no build command.
- `.env` should not be uploaded.
- If you later use Wrangler, deploy from the project root so `wrangler.toml` is used.
