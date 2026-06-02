# Deployment

This app has two production pieces:

- Convex runs the backend functions and database from `convex`.
- Your server only serves the static files generated into `dist`.

There is no Node app in this repository that needs to keep running on your server. After deployment, browsers load the static frontend from your host, then connect directly to the production Convex URL embedded during the build.

## One-time setup

1. Create or choose a Convex production deployment.
2. Set the Convex production environment variable:

   ```sh
   npx convex env set ADMIN_PASSWORD 'replace-me'
   ```

3. Generate a Convex production deploy key from the Convex dashboard.
4. Add these GitHub repository secrets:

   ```text
   CONVEX_DEPLOY_KEY
   SSH_PRIVATE_KEY
   SSH_KNOWN_HOSTS
   DEPLOY_HOST
   DEPLOY_USER
   DEPLOY_PATH
   DEPLOY_PORT
   ```

`DEPLOY_PORT` can be omitted if your SSH server uses port `22`.

`SSH_KNOWN_HOSTS` should contain the host key line for your server. You can generate it with:

```sh
ssh-keyscan -p 22 your-hostname
```

Use the public key that matches `SSH_PRIVATE_KEY` in your server user's `authorized_keys`. The `DEPLOY_PATH` directory should be the web root for the site, and the deploy user needs write access to it.

## Deploying

Pushing to `main` runs `.github/workflows/deploy.yml`. You can also run it manually from GitHub Actions.

The workflow:

1. Installs dependencies with pnpm.
2. Runs `convex deploy`, which deploys the backend and builds the frontend with `VITE_CONVEX_URL` pointed at production.
3. Uploads `dist` to your server with `rsync --delete`.

No workflow runs for pull requests or non-`main` branch pushes.

## Server requirements

The server only needs to serve static files. Configure your web server so every route falls back to `index.html`, because this is a client-side Vite app.

For nginx, the important part is:

```nginx
try_files $uri $uri/ /index.html;
```

Do not set `VITE_ADMIN_PASSWORD` for production builds. It is only a local fallback; production admin login should use the `ADMIN_PASSWORD` environment variable stored on the Convex deployment.
