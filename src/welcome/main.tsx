import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { WelcomePage } from './WelcomePage';
import pageStyles from './styles.css?inline';

const style = document.createElement('style');
style.textContent = pageStyles;
document.head.appendChild(style);

const container = document.getElementById('root');
if (container) createRoot(container).render(createElement(WelcomePage));
