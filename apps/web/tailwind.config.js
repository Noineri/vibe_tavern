/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        s2: 'var(--s2)',
        s3: 'var(--s3)',
        border: 'var(--border)',
        border2: 'var(--border2)',
        t1: 'var(--t1)',
        t2: 'var(--t2)',
        t3: 'var(--t3)',
        t4: 'var(--t4)',
        accent: 'var(--accent)',
        'accent-t': 'var(--accent-t)',
        'accent-dim': 'var(--accent-dim)',
        'accent-hover': 'var(--accent-hover)',
        'on-accent': 'var(--on-accent)',
        danger: 'var(--danger)',
        'danger-dim': 'var(--danger-dim)',
        'danger-text': 'var(--danger-text)',
        success: 'var(--success)',
        'success-dim': 'var(--success-dim)',
        'success-text': 'var(--success-text)',
        warning: 'var(--warning)',
        'warning-dim': 'var(--warning-dim)',
        'warning-text': 'var(--warning-text)',
        info: 'var(--info)',
        'info-dim': 'var(--info-dim)',
        'info-text': 'var(--info-text)',
        'user-bg': 'var(--user-bg)',
      },
      fontFamily: {
        ui: ['var(--font-ui)'],
        body: ['var(--font-body)'],
      },
      borderRadius: {
        r: 'var(--r)',
      },
      spacing: {
        sw: 'var(--sw)',
      },
      maxWidth: {
        msg: 'var(--mw)',
      },
    },
  },
};
