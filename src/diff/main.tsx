import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import diffStyles from '../shared/diff.css?inline';
import { DiffPage } from './DiffPage';
import pageStyles from './styles.css?inline';

const style = document.createElement('style');
style.textContent = `${diffStyles}\n${pageStyles}`;
document.head.appendChild(style);

const container = document.getElementById('root');
if (container) createRoot(container).render(createElement(DiffPage));
