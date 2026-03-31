import forms from '@tailwindcss/forms';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx,html}',
    './src/extensions-private/**/src/renderer/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {},
  },
  plugins: [
    forms,
  ],
}
