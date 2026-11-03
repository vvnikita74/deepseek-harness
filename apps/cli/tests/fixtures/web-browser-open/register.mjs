// Test-only preload: exits the Web process once its URL line prints.
if (process.env.DSH_BROWSER_OPEN_TEST_EXIT_ON_READY === '1') {
  const originalLog = console.log
  console.log = (...args) => {
    originalLog(...args)
    if (typeof args[0] === 'string' && args[0].startsWith('dsh web: ')) {
      setTimeout(() => process.exit(0), 250)
    }
  }
}
