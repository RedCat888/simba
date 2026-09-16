# WiFi sensing with two RTL8188EU adapters — starting brief

Prepared 2026-08-22 for a fresh session. Everything below was measured on this
machine, not assumed. The point of writing it down is so the next session does
not spend its first hour rediscovering what is already known.

## The goal

the operator shared a reel about seeing people through walls with WiFi and asked
Simba to "download and setup the project or code that lets wifi thru walls
work". He has since bought two USB WiFi adapters specifically to try it, and
wants to build, test and hack on this rather than be told it is impossible.

## What is ruled out, with evidence

**Channel State Information, and therefore anything pose-shaped.** The published
through-wall work (DensePose-from-WiFi and its descendants) needs CSI: per-
subcarrier amplitude and phase, typically across a 3x3 MIMO array.

- The adapter is a Realtek RTL8188EU. CSIKit — the main CSI library — supports
  Atheros, Intel 5300/AX200/AX210, Nexmon (Broadcom), ESP32 and PicoScenes.
  RTL8188EU is on none of those lists.
- Realtek does sell CSI-capable silicon, but it is the Ameba IoT
  microcontroller line (RTL8720/8730), not this dongle.
- Each adapter is 1x1. Two separate USB radios are not a MIMO array; they have
  no shared clock or phase reference. Having two does not change this.

Do not spend time looking for an RTL8188EU CSI patch. If a session finds one,
verify it produces real subcarrier data before believing it.

## What is actually achievable

Device-free motion and presence sensing from received signal strength. A body
moving between a transmitter and a receiver perturbs the link measurably. This
is real, published, and much cruder than CSI: expect "something moved in the
room", possibly "roughly where between the two antennas", and nothing resembling
a skeleton.

Two adapters make this a proper controlled experiment rather than passive
eavesdropping: one can be a soft AP transmitting steadily, the other a station
measuring what arrives.

## Environment, measured

- Adapter: `Realtek RTL8188EU Wireless LAN 802.11n USB 2.0`, USB\VID_0BDA&PID_8179,
  MAC 78-8C-B5-A0-1B-E7, Realtek driver 1030.52.1216.2025. Two units available.
- The PC is otherwise wired only (Intel I219-V). These are its only radios.
- `MSNdis_80211_ReceivedSignalStrength` (real dBm via WMI): **Not supported** by
  this driver. Checked directly.
- `MSNdis_80211_BSSIList` (per-BSSID RSSI via WMI): **Not supported**. Checked.
- `netsh wlan show networks mode=bssid` **works** and returns per-BSSID signal as
  a *percentage* (observed 73%, 82%). This is the only native signal source that
  responds.
- No Npcap, no Wireshark, no `wpcap.dll`.
- WSL2 is installed but the only distribution is `docker-desktop`. There is no
  general-purpose distro.
- `usbipd-win` is not installed, so USB devices cannot currently be passed into
  WSL2.
- Windows 11 Pro 26220. PowerShell 5.1 plus Git Bash.

## Candidate paths, best first

**1. Linux monitor mode with radiotap RSSI.** The real one. RTL8188EU has good
Linux support (`rtl8188eu` / `rtl8xxxu`) and monitor mode works, giving per-frame
RSSI in dBm rather than a percentage. Routes:
   - `usbipd-win` + WSL2 + a real distro. Caveat worth checking early: the stock
     WSL2 kernel does not ship most USB WiFi drivers, so this may need a custom
     WSL2 kernel build. Establish that before committing to the path.
   - A spare machine or Raspberry Pi running Linux directly. Simplest if one
     exists.
   - A live USB Linux boot for experiments, with results carried back.

**2. Windows-native scan polling.** Poll `netsh wlan show networks mode=bssid`
on a loop, parse per-BSSID percentages, and look for variance. Zero setup, and
genuinely weak: scans take seconds, percentages are quantised, and the sample
rate is far below what movement detection wants. Worth one afternoon as a
baseline to prove the pipeline end to end, not as the destination.

**3. Soft AP pair.** Use one adapter as a hosted network / Mobile Hotspot and the
other as a station connected to it, so both ends of the link are controlled.
Combine with whichever measurement path above works.

## Definition of a first success

A time series of link quality between the two adapters, logged at the highest
rate the chosen path allows, showing a visible and repeatable deflection when a
person walks between them and none when the room is empty. Everything past that
— thresholds, presence versus motion, direction — depends on having that.

## Constraints that matter on this machine

- Postgres is the source of truth. If this produces a usable signal, it lands in
  Simba as events or captures, not as files. Do not write state to markdown.
- This box has a history of commit-charge exhaustion. Check commit before
  blaming a build.
- Never kill node.exe, java.exe, python.exe or Gradle daemons without listing
  them and asking; Cursor and Claude Code are node processes.
- Any shell command over three lines goes in a script file first. PowerShell
  strings must be ASCII.
- No credentials in tracked files. Env var names only.
- Simba lives at C:\example-workspace\simba. `npm run check` must exit 0 before any
  work counts as done.

## Open request

There is a row in `requests` (status `open`, source `reel:instagram`) carrying
the original ask and two rounds of findings. Update its `outcome` as this
progresses rather than starting a separate record.
