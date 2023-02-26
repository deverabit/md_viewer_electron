"use strict"

const fs = require("fs")
const path = require("path")

const electron = require("electron")
const remote = require("@electron/remote")

const common = require("./lib/common")
const contentBlocking = require("./lib/contentBlocking/contentBlockingRenderer")
const documentRendering = require("./lib/documentRendering/documentRenderingRenderer")
const encodingLib = require("./lib/encoding/encodingRenderer")
const ipc = require("./lib/ipc/ipcRenderer")
const log = require("./lib/log/log")
const navigation = require("./lib/navigation/navigationRenderer")
const rawText = require("./lib/rawText/rawTextRenderer")
const toc = require("./lib/renderer/toc")

const TITLE = "Markdown Viewer"

function alterTags(tagName, handler) {
    ;[...document.getElementsByTagName(tagName)].forEach(handler)
}

function updateStatusBar(text) {
    document.getElementById("status-text").innerHTML = text
}

function clearStatusBar() {
    updateStatusBar("")
}

function statusOnMouseOver(element, text) {
    element.onmouseover = () => updateStatusBar(text)
    element.onmouseout = () => clearStatusBar()
}

function alterStyleURLs(documentDirectory, fileContent) {
    const pattern = /url\(["'](?<url>.*?)["']\)/
    let isInStyle = false
    let isInCode = false
    const lines = fileContent.split(/\r?\n/)
    const lineCount = lines.length
    for (let i = 0; i < lineCount; i++) {
        const line = lines[i].trim()
        if (line === "<style>") {
            isInStyle = true
        } else if (line === "</style>") {
            isInStyle = false
        } else if (line.startsWith("```")) {
            isInCode = !isInCode
        }
        if (isInStyle && !isInCode) {
            const url = line.match(pattern)?.groups.url
            if (!url || common.isWebURL(url)) {
                continue
            }
            lines[i] = line.replace(
                pattern,
                `url("${path.join(documentDirectory, url).replace(/\\/g, "/")}")`
            )
        }
    }
    return lines.join("\n")
}

function fittingTarget(target, nodePattern) {
    if (!target) {
        return null
    }
    if (target.nodeName.toLowerCase().match(nodePattern)) {
        return target
    }
    return fittingTarget(target.parentNode, nodePattern)
}

function scrollTo(position) {
    document.documentElement.scrollTop = position
}

function reload(isFileModification, encoding) {
    ipc.send(
        ipc.messages.reloadPrepared,
        isFileModification,
        encoding,
        document.documentElement.scrollTop
    )
}

function isDataUrl(url) {
    return url.startsWith("data:")
}

function registerDraggableElement(separatorElementId, leftElementId, rightElementId) {
    const separator = document.getElementById(separatorElementId)
    const left = document.getElementById(leftElementId)
    const right = document.getElementById(rightElementId)

    let mouseDownInfo
    separator.onmousedown = event => {
        mouseDownInfo = {
            event,
            offsetLeft: separator.offsetLeft,
            leftWidth: left.offsetWidth,
            rightWidth: right.offsetWidth,
        }
        document.onmousemove = event => {
            // Horizontal; prevent negative-sized elements
            const deltaX = Math.min(
                Math.max(event.clientX - mouseDownInfo.event.clientX, -mouseDownInfo.leftWidth),
                mouseDownInfo.rightWidth
            )

            separator.style.left = `${mouseDownInfo.offsetLeft + deltaX}px`
            left.style.width = `${mouseDownInfo.leftWidth + deltaX}px`
            right.style.width = `${mouseDownInfo.rightWidth - deltaX}px`
        }
        document.onmouseup = () => (document.onmousemove = document.onmouseup = null)
    }
}

function populateToc(content, outlineElementId) {
    document.getElementById(outlineElementId).innerHTML = toc.build(content).toHtml()
}

function handleDOMContentLoadedEvent() {
    document.title = TITLE

    registerDraggableElement("separator", "outline", "content-body")

    ipc.init()
    log.init()
    contentBlocking.init(document, window)
    rawText.init(document, window, updateStatusBar)
    navigation.init(document)

    ipc.send(ipc.messages.finishLoad)
}

function handleContextMenuEvent(event) {
    const toClipboard = electron.clipboard.writeText
    const MenuItem = remote.MenuItem
    const menu = new remote.Menu()

    if (window.getSelection().toString()) {
        menu.append(
            new MenuItem({
                label: "Copy selection",
                role: "copy",
            })
        )
    }

    const target = event.target
    const headerElement = fittingTarget(target, /h\d/)
    if (headerElement) {
        menu.append(
            new MenuItem({
                label: "Copy header anchor",
                click() {
                    toClipboard(headerElement.getAttribute("id"))
                },
            })
        )
    }

    const linkElement = fittingTarget(target, /a/)
    if (linkElement) {
        menu.append(
            new MenuItem({
                label: "Copy link text",
                click() {
                    toClipboard(linkElement.innerText)
                },
            })
        )
        menu.append(
            new MenuItem({
                label: "Copy link target",
                click() {
                    toClipboard(linkElement.getAttribute("href"))
                },
            })
        )
    }

    if (menu.items.length > 0) {
        menu.popup({
            window: remote.getCurrentWindow(),
        })
    }
}

document.addEventListener("DOMContentLoaded", handleDOMContentLoadedEvent)

ipc.listen(ipc.messages.fileOpen, file => {
    toc.reset()
    contentBlocking.changeInfoElementVisiblity(false)
    clearStatusBar()

    const filePath = file.path
    const buffer = fs.readFileSync(filePath)
    let encoding = file.encoding
    if (!encoding) {
        encoding = encodingLib.detect(buffer)
        ipc.send(ipc.messages.changeEncoding, filePath, encoding)
    }
    let content = encodingLib.decode(buffer, encoding)

    if (!documentRendering.shallRenderAsMarkdown()) {
        const pathParts = filePath.split(".")
        const language = pathParts.length > 1 ? pathParts[pathParts.length - 1] : ""

        // If a Markdown file has to be rendered as source code, the code block enclosings
        // ``` have to be escaped. Unicode has an invisible separator character U+2063 that
        // fits this purpose.
        content = "```" + language + "\n" + content.replaceAll("```", "\u2063```") + "\n```"

        ipc.send(ipc.messages.disableRawView)
    } else {
        ipc.send(ipc.messages.enableRawView)
    }

    // URLs in cotaining style definitions have to be altered before rendering
    const documentDirectory = path.resolve(path.dirname(filePath))
    content = alterStyleURLs(documentDirectory, content)

    document.getElementById("content-body").innerHTML = documentRendering.renderContent(content)
    document.getElementById("raw-text").innerHTML = documentRendering.renderRawText(content)
    populateToc(content, "outline-content")

    // Alter local references to be relativ to the document
    alterTags("a", link => {
        const target = link.getAttribute("href")
        if (target) {
            navigation.openLink(link, target, documentDirectory)
            statusOnMouseOver(link, target)
        }
    })
    alterTags("img", image => {
        const imageUrl = image.getAttribute("src")
        if (!common.isWebURL(imageUrl) && !isDataUrl(imageUrl)) {
            image.src = path.join(documentDirectory, imageUrl).replace("#", "%23")
        }
        statusOnMouseOver(image, `${image.getAttribute("alt")} (${imageUrl})`)

        image.onerror = () => (image.style.backgroundColor = "#ffe6cc")
    })

    const scrollPosition = file.scrollPosition
    const internalTarget = file.internalTarget
    let titlePrefix = filePath
    if (scrollPosition) {
        scrollTo(scrollPosition)
    }
    if (internalTarget) {
        const targetElement = document.getElementById(internalTarget.replace("#", "").split(".")[0])
        if (targetElement) {
            if (!scrollPosition) {
                scrollTo(
                    targetElement.getBoundingClientRect().top -
                        document.body.getBoundingClientRect().top
                )
            }
            titlePrefix += internalTarget
        } else {
            titlePrefix += ` ("${internalTarget}" not found)`
        }
    }
    if (!scrollPosition && !internalTarget) {
        scrollTo(0)
    }
    document.title = `${titlePrefix} - ${TITLE} ${remote.app.getVersion()}`

    window.addEventListener("contextmenu", handleContextMenuEvent)
})

ipc.listen(ipc.messages.prepareReload, reload)

ipc.listen(ipc.messages.restorePosition, scrollTo)

ipc.listen(ipc.messages.changeZoom, zoomFactor => electron.webFrame.setZoomFactor(zoomFactor))

ipc.listen(ipc.messages.changeRenderingOptions, options => {
    documentRendering.reset(options)
    reload(false)
})
