import { port } from './serve'
import fetch from 'node-fetch'
import { mochaReset, mochaSetup, untilUpdated } from '../../testUtils'

const url = `http://localhost:${port}`

describe('optimize-missing-deps.spec.ts', () => {
  before(mochaSetup)
  after(mochaReset)

  it('*', async () => {
    await page.goto(url)
    // reload page to get optimized missing deps
    await page.reload()
    await untilUpdated(() => page.textContent('div'), 'Client')

    // raw http request
    const aboutHtml = await (await fetch(url)).text()
    expect(aboutHtml).toMatch('Server')
  })
})
