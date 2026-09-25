// Welcome page: render the bundled tool list from the shared registry.
import { TOOLS, CATEGORY_ORDER } from '../src/registry.js';

document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

const cards = document.getElementById('tool-cards');
const sorted = [...TOOLS].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
);

for (const tool of sorted) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `
        <div class="cat"></div>
        <div class="name"></div>
        <div class="desc"></div>`;
    card.querySelector('.cat').textContent = tool.defaultEnabled === false
        ? `${tool.category} · off by default`
        : tool.category;
    card.querySelector('.name').textContent = tool.name;
    card.querySelector('.desc').textContent = tool.description;
    cards.appendChild(card);
}
