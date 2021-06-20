const assert = require("chai").assert

const mocking = require("./mocking")

const ipc = require("../app/lib/ipc")

describe("Content blocking", () => {
    describe("Main part", () => {
        const contentBlocking = require("../app/lib/contentBlocking/contentBlockingMain")

        const expectedUrl = "http://example.com"

        beforeEach(() =>
            contentBlocking.init(mocking.mainWindow, mocking.mainMenu, mocking.electron)
        )

        afterEach(() => {
            mocking.clear()
            contentBlocking.clearUnblockedURLs()
        })

        it("unblocks all", () => {
            mocking.register.ipc.webContentsSend(ipc.messages.unblockAll)
            contentBlocking.unblockAll()
        })

        it("unblocks a URL", () => {
            const unblockMessage = ipc.messages.unblockURL
            mocking.register.ipc.mainOn(unblockMessage, (_, url) => assert.equal(url, expectedUrl))
            mocking.send.ipc.toMain(unblockMessage, {}, expectedUrl)
        })

        it("unblocks always redirection URLs", () => {
            mocking.register.webRequest.onBeforeRedirect(details =>
                assert.equal(details.redirectURL, expectedUrl)
            )
            mocking.send.webRequest.beforeRedirect({
                redirectURL: expectedUrl,
            })
            assert.isTrue(contentBlocking.unblockedURLs.includes(expectedUrl))
        })

        describe("Request handler", () => {
            function buildRequestCallback(isBlocked) {
                return options => assert.equal(options.cancel, isBlocked)
            }

            beforeEach(() =>
                mocking.register.webRequest.onBeforeRequest(details =>
                    assert.equal(details.url, expectedUrl)
                )
            )

            it("blocks a URL", () => {
                mocking.register.ipc.webContentsSend(ipc.messages.contentBlocked)
                mocking.send.webRequest.beforeRequest(
                    {
                        url: expectedUrl,
                    },
                    buildRequestCallback(true)
                )
            })

            it("does not block an unblocked URL", () => {
                mocking.send.ipc.toMain(ipc.messages.unblockURL, {}, expectedUrl)
                mocking.send.webRequest.beforeRequest(
                    {
                        url: expectedUrl,
                    },
                    buildRequestCallback(false)
                )
            })
        })
    })
})
