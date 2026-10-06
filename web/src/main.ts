// The entry of the client. Each static import here is a part of the first download, so this file
// and App.svelte name the files of web/src/ui that they need, and not its index file.
import './ui/tokens.css';
import './ui/base.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { toast } from './data/index.ts';
import { registerServiceWorker } from './pwa/register.ts';
import { closeShell, setLaunch, update } from './shell/app.svelte.ts';

mount(App, { target: document.getElementById('app')! });

// After the mount: the worker must not take time from the first screen.
registerServiceWorker({
  onUpdateReady(apply) {
    update.apply = apply;
    // Longer than a usual message: the person did not start this one, and can be in the middle of a task.
    toast.show({ message: 'New version ready', action: { label: 'Reload', run: apply }, duration: 20_000 });
  },
  onOpenTask(taskId) {
    // The task must not open behind Settings.
    closeShell();
    setLaunch({ taskId });
  },
});
