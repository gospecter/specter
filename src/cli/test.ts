import { createAdapter } from '../cms/index.js';
import { loadConfig } from '../config.js';

interface TestOptions {
  /** Platform discriminator for ad-hoc checks. Defaults to 'ghost' when --url/--key are passed. */
  platform?: 'ghost' | 'shopify' | 'wordpress';
  url?: string;
  key?: string;
  // WordPress ad-hoc flags
  siteUrl?: string;
  username?: string;
  appPassword?: string;
  // Shopify ad-hoc flags
  shop?: string;
  accessToken?: string;
  apiVersion?: string;
  /** Test a specific target by handle (multi-target configs). */
  target?: string;
  json?: boolean;
}

/**
 * Test connection to a CMS.
 *
 * - With `--url` and `--key`: ad-hoc Ghost connection check. Used by the
 *   onboarding UI's "Test Connection" button before any config is written.
 * - With `--platform wordpress --site-url --username --app-password`: ad-hoc
 *   WordPress connection check (used by Phase 7 WordPress add-target UI).
 * - With `--platform shopify --shop --access-token [--api-version]`: ad-hoc
 *   Shopify connection check.
 * - With `--target <handle>`: test that specific target from the saved config.
 * - With no flags: test every configured target. Exits non-zero if any fail.
 *
 * `--json` emits `{ok, message}` (single target) or `{ok, results:[{handle,ok,message}]}`
 * (multi-target) for programmatic consumers.
 */
export async function testCommand(options: TestOptions): Promise<void> {
  // Ad-hoc Shopify check — bypass the saved config entirely.
  if (options.platform === 'shopify' && options.shop && options.accessToken) {
    await runSingle(
      {
        platform: 'shopify',
        shop: options.shop,
        accessToken: options.accessToken,
        apiVersion: options.apiVersion,
      },
      'shopify',
      options.json ?? false,
    );
    return;
  }

  // Ad-hoc WordPress check — bypass the saved config entirely.
  if (options.platform === 'wordpress' && options.siteUrl && options.username && options.appPassword) {
    await runSingle(
      {
        platform: 'wordpress',
        siteUrl: options.siteUrl,
        username: options.username,
        appPassword: options.appPassword,
      },
      'wordpress',
      options.json ?? false,
    );
    return;
  }

  // Ad-hoc Ghost check — bypass the saved config entirely.
  if (options.url && options.key) {
    await runSingle(
      { platform: 'ghost', ghostUrl: options.url, adminApiKey: options.key },
      'ghost',
      options.json ?? false,
    );
    return;
  }

  const config = await loadConfig();
  if (!config || config.targets.length === 0) {
    emitSingle(options.json ?? false, false, 'No targets configured. Run `ghost-sync init` first.');
    return;
  }

  if (options.target) {
    const target = config.targets.find((t) => t.handle === options.target);
    if (!target) {
      emitSingle(options.json ?? false, false, `No target with handle '${options.target}'.`);
      return;
    }
    await runSingle(target.adapter, target.handle, options.json ?? false);
    return;
  }

  // Test every target in order. Aggregate success: all must pass.
  const results: { handle: string; ok: boolean; message: string }[] = [];
  for (const target of config.targets) {
    try {
      const adapter = createAdapter(target.adapter);
      const r = await adapter.testConnection();
      results.push({ handle: target.handle, ok: r.ok, message: r.message });
    } catch (err) {
      results.push({
        handle: target.handle,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const allOk = results.every((r) => r.ok);
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: allOk, results }) + '\n');
  } else {
    for (const r of results) {
      console.log(`${r.ok ? 'OK' : 'FAIL'} [${r.handle}]: ${r.message}`);
    }
  }
  process.exit(allOk ? 0 : 1);
}

async function runSingle(
  adapterConfig: Parameters<typeof createAdapter>[0],
  handle: string,
  json: boolean,
): Promise<void> {
  try {
    const adapter = createAdapter(adapterConfig);
    const result = await adapter.testConnection();
    if (json) {
      process.stdout.write(JSON.stringify({ ok: result.ok, message: result.message }) + '\n');
    } else {
      console.log(`${result.ok ? 'OK' : 'FAIL'} [${handle}]: ${result.message}`);
    }
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    emitSingle(json, false, err instanceof Error ? err.message : String(err));
  }
}

function emitSingle(json: boolean, ok: boolean, message: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok, message }) + '\n');
  } else {
    console.log(`${ok ? 'OK' : 'FAIL'}: ${message}`);
  }
  process.exit(ok ? 0 : 1);
}
