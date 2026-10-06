import '../src/ui/tokens.css';
import '../src/ui/base.css';
import { mount } from 'svelte';
import WideDev from './WideDev.svelte';

mount(WideDev, { target: document.getElementById('app')! });
