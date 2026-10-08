// A soft layered chime is synthesized locally, so no audio file or network request is needed.
export async function unlockAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;

  const ac = new AudioContextClass();
  try {
    await ac.resume();
    if (ac.state !== "running") {
      await ac.close();
      return false;
    }
    const oscillator = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(ac.destination);
    oscillator.start();
    oscillator.stop(ac.currentTime + 0.01);
    window.setTimeout(() => {
      if (ac.state !== "closed") void ac.close();
    }, 500);
    return true;
  } catch (error) {
    if (ac.state !== "closed") await ac.close();
    throw error;
  }
}

export async function chime() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;

  const ac = new AudioContextClass();
  try {
    await Promise.race([
      ac.resume(),
      new Promise((resolve) => window.setTimeout(resolve, 500)),
    ]);
  } catch (error) {
    await ac.close();
    throw error;
  }
  if (ac.state !== "running") {
    await ac.close();
    return false;
  }

  [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
    const oscillator = ac.createOscillator();
    const gain = ac.createGain();
    const start = ac.currentTime + index * 0.13;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.connect(gain);
    gain.connect(ac.destination);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 2);
    oscillator.start(start);
    oscillator.stop(start + 2.1);
  });
  window.setTimeout(() => {
    if (ac.state !== "closed") void ac.close();
  }, 2500);
  return true;
}
export async function askNotify() { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); }
export function notify(title, body) { if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, icon: "assets/images/logo.png" }); }
