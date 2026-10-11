const mode = document.querySelector('#mode');
try {
  const response = await fetch('/health');
  if (!response.ok) throw new Error('Health request failed');
  const { data } = await response.json();
  mode.textContent = `${data.mode} / ${data.storageBackend}`;
} catch {
  mode.textContent = 'Platform health unavailable';
}
