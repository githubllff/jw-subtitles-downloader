// Category fallback adjustment:
// Replace the existing rule:
// if (/^pub-jwb-\d+_/i.test(id || '')) return 'broadcasting';
// with:
// if (/^pub-jwb-\d+_1_VIDEO$/i.test(id || '')) return 'broadcasting';
// This routes individual segments such as pub-jwb-112_6_VIDEO and pub-jwb-128_8_VIDEO to Other.