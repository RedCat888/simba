/**
 * SIMBA_GATEWAY_HOST must refuse anything but loopback.
 *
 * The local listener grants desktop authority with no identity check — safe
 * only because nothing off this machine can reach the port. One environment
 * variable used to be able to undo that, and nothing downstream would notice,
 * because the requests still arrive on the local port and therefore still look
 * local.
 */
try {
  const m = await import('../src/config.js');
  console.log(`ACCEPTED host=${m.config.gateway.host}`);
} catch (e) {
  console.log(`REFUSED: ${(e as Error).message.slice(0, 100)}`);
}
process.exit(0);
