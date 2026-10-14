import React from 'react';

// Stand-in for next/link in the accessibility harness: a plain anchor.
export default function Link({ href, children, prefetch: _prefetch, ...rest }) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
