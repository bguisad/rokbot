import { t } from './i18n.js';
import { icon } from './icons.js';
import { node } from './ui.js';
import { pages, routeHash } from './admin-routes.js';

// The sidebar and the page tabs both come from the registry in admin-routes.js.
export function renderNavigation(root) {
  root.replaceChildren();
  for (const page of pages) {
    const link = node('a', 'nav-item');
    link.href = routeHash(page); link.dataset.route = page.id;
    link.innerHTML = icon(page.icon);
    link.append(node('span', '', t(page.label)));
    root.append(link);
  }
}

export function markNavigation(root, page) {
  for (const link of root.querySelectorAll('.nav-item[data-route]')) {
    const active = link.dataset.route === page.id;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
}

/** Fills the page head: title, description and (for pages with more than one) the tab bar. */
export function renderPageHead(root, page, tab) {
  const head = node('header', 'route-head'), copy = node('div', 'route-copy');
  const title = node('h1', 'route-title', t(page.label));
  title.id = 'route-title';
  copy.append(title, node('p', 'route-description', t(page.description)));
  head.append(copy);
  if (page.tabs.length > 1) {
    const bar = node('nav', 'route-tabs');
    bar.setAttribute('aria-label', t('{0}分页', t(page.label)));
    for (const item of page.tabs) {
      const link = node('a', 'route-tab', t(item.label));
      link.href = routeHash(page, item); link.dataset.tab = item.id;
      if (item === tab) link.setAttribute('aria-current', 'page');
      bar.append(link);
    }
    head.append(bar);
  }
  root.replaceChildren(head);
  root.querySelector('[aria-current=page]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

export const pageTitle = (page, tab) => page.tabs.length > 1 ? `${t(tab.label)} · ${t(page.label)}` : t(page.label);
