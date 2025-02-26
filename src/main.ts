import * as vscode from 'vscode';
import * as fs from 'fs';
import { Group, maxGroupNameLength, defaultGroupName, externalGroupName } from "./group";
import {
    ExtensionContext,
    FileDeleteEvent, FileRenameEvent,
    OverviewRulerLane,
    Range, Selection,
    StatusBarItem,
    TextDocument, TextDocumentChangeEvent, TextEditor, TextEditorDecorationType
} from 'vscode';
import { DecorationFactory } from './decoration_factory';
import { GroupPickItem } from './group_pick_item';
import { BookmarkPickItem } from './bookmark_pick_item';
import { ShapePickItem } from './shape_pick_item';
import { ColorPickItem } from './color_pick_item';
import { Bookmark } from "./bookmark";
import { SerializableGroup } from "./serializable_group";
import { SerializableBookmark } from "./serializable_bookmark";
import { BookmarkDataProvider } from './interface/bookmark_data_provider';
import { BookmarManager } from './interface/bookmark_manager';
import { Logger } from './logger/logger';

export class Main implements BookmarkDataProvider, BookmarManager {
    public ctx: ExtensionContext;
    public logger: Logger;

    private treeViewRefreshCallback = () => { };

    // file storage
    public readonly savedBookmarksFileVersionKey = "fileVersion";
    public readonly savedBookmarksFileVersionValue = "1.0";
    public readonly savedBookmarksFilePath = vscode.workspace.workspaceFolders?vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, "/") + "/.vscode/bookmarks-labeled.json":undefined;
    public readonly savedBookmarksDelay = 2500;

    public readonly savedBookmarksKey = "vscLabeledBookmarks.bookmarks";
    public readonly savedGroupsKey = "vscLabeledBookmarks.groups";
    public readonly savedActiveGroupKey = "vscLabeledBookmarks.activeGroup";
    public readonly savedHideInactiveGroupsKey = "vscLabeledBookmarks.hideInactiveGroups";
    public readonly savedHideAllKey = "vscLabeledBookmarks.hideAll";

    public readonly configRoot = "labeledBookmarks";
    public readonly configKeyColors = "colors";
    public readonly configKeyUnicodeMarkers = "unicodeMarkers";
    public readonly configKeyDefaultShape = "defaultShape";
    public readonly configOverviewRulerLane = "overviewRulerLane";
    public readonly configLineEndLabelType = "lineEndLabelType";

    public groups: Array<Group>;
    private bookmarks: Array<Bookmark>;

    public activeGroup: Group;
    public fallbackColor: string = "00ddddff";
    public fallbackColorName: string = "teal";

    public colors: Map<string, string>;
    public unicodeMarkers: Map<string, string>;
    public readonly shapes: Map<string, string>;
    public defaultShape = "bookmark";

    public hideInactiveGroups: boolean;
    public hideAll: boolean;

    private statusBarItem: StatusBarItem;

    private removedDecorations: Map<TextEditorDecorationType, boolean>;

    private tempDocumentBookmarks: Map<string, Array<Bookmark>>;
    private tempGroupBookmarks: Map<Group, Array<Bookmark>>;
    private tempDocumentDecorations: Map<string, Map<TextEditorDecorationType, Array<Range>>>;

    private decorationFactory: DecorationFactory;

    private lastSaveTimestamp: number = 0;

    constructor(ctx: ExtensionContext, treeviewRefreshCallback: () => void) {
        this.ctx = ctx;
        this.logger = new Logger("vsc-labeled-bookmarks", true);
        this.logger.log("CONSTRUCTOR");

        this.treeViewRefreshCallback = treeviewRefreshCallback;

        let gutterIconDirUri = vscode.Uri.joinPath(this.ctx.extensionUri, 'resources', 'gutter_icons');
        this.decorationFactory = new DecorationFactory(gutterIconDirUri, OverviewRulerLane.Center, "bordered");

        this.bookmarks = new Array<Bookmark>();
        this.groups = new Array<Group>();
        this.activeGroup = new Group(defaultGroupName, this.fallbackColor, this.defaultShape, "", this.decorationFactory)

        this.colors = new Map<string, string>();
        this.unicodeMarkers = new Map<string, string>();
        this.shapes = new Map<string, string>([
            ["bookmark", "bookmark"],
            ["circle", "circle"],
            ["heart", "heart"],
            ["label", "label"],
            ["star", "star"]
        ]);

        this.removedDecorations = new Map<TextEditorDecorationType, boolean>();
        this.tempDocumentBookmarks = new Map<string, Array<Bookmark>>();
        this.tempGroupBookmarks = new Map<Group, Array<Bookmark>>();
        this.tempDocumentDecorations = new Map<string, Map<TextEditorDecorationType, Array<Range>>>();

        this.readSettings();
        if (this.colors.size < 1) {
            this.colors.set(this.fallbackColorName, this.decorationFactory.normalizeColorFormat(this.fallbackColor));
        }
        this.hideInactiveGroups = false;
        this.hideAll = false;

        // loading / initial
        let loaded = this.loadState()
        if (!loaded) {
            this.groups.push( new Group(externalGroupName, "00dd00ff", this.defaultShape, "", this.decorationFactory));
            this.groups.push( new Group(defaultGroupName, this.fallbackColor, this.defaultShape, "", this.decorationFactory));
            this.activeGroup = this.groups[this.groups.length-1]
            this.saveState();
        }

        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
        this.statusBarItem.command = 'vsc-labeled-bookmarks.selectGroup';
        this.statusBarItem.show();

        this.updateDecorations();
        this.createWatcher();
        this.logger.log("CONSTRUCTOR done");
    }

    private createWatcher() {
        if (!this.savedBookmarksFilePath) {
            this.logger.log("WATCHER has no target path...");
            return false
        }

        this.logger.log("WATCHER for " + this.savedBookmarksFilePath + " (" + this.savedBookmarksDelay + ")");
        const watcher = vscode.workspace.createFileSystemWatcher(this.savedBookmarksFilePath, true, false, true);
        watcher.onDidChange((e: vscode.Uri) => {
            this.logger.log("WATCHER file changed: " + e.fsPath);
            if (this.lastSaveTimestamp < Date.now() - this.savedBookmarksDelay) {
                this.loadState();
            }
        });

        return true
    }

    private loadState() {
        if (!this.savedBookmarksFilePath) {
            this.logger.log("LOAD has no target path...");
            return false
        }
        this.logger.log("LOAD from " + this.savedBookmarksFilePath);

        if (!fs.existsSync(this.savedBookmarksFilePath)) {
            this.logger.log("LOAD file no found...");
            return false
        }

        // read
        let data = fs.readFileSync(this.savedBookmarksFilePath, 'utf8');
        let obj = JSON.parse(data);
        if (obj[this.savedBookmarksFileVersionKey] === this.savedBookmarksFileVersionValue) {
            this.ctx.workspaceState.update(this.savedBookmarksKey, obj[this.savedBookmarksKey]);
            this.ctx.workspaceState.update(this.savedGroupsKey, obj[this.savedGroupsKey]);
            this.ctx.workspaceState.update(this.savedActiveGroupKey, obj[this.savedActiveGroupKey]);
            this.ctx.workspaceState.update(this.savedHideInactiveGroupsKey, obj[this.savedHideInactiveGroupsKey]);
            this.ctx.workspaceState.update(this.savedHideAllKey, obj[this.savedHideAllKey]);
            //vscode.window.showInformationMessage("LOAD restored labeled bookmarks from file");
            this.logger.log("LOAD restored labeled bookmarks from file");
        } else {
            // ATM:: there are no breaking versions
            vscode.window.showWarningMessage("LOAD restored labeled bookmarks from file FAILED, version mismatch?");
            this.logger.log("LOAD restored labeled bookmarks from file FAILED, version mismatch?");
            return false
        }

        this.hideInactiveGroups = this.ctx.workspaceState.get(this.savedHideInactiveGroupsKey) ?? false;
        this.hideAll = this.ctx.workspaceState.get(this.savedHideAllKey) ?? false;

        let activeGroupName: string = this.ctx.workspaceState.get(this.savedActiveGroupKey) ?? defaultGroupName;
        let serializedGroups: Array<SerializableGroup> | undefined = this.ctx.workspaceState.get(this.savedGroupsKey);
        this.groups = new Array<Group>();
        if (typeof serializedGroups !== "undefined") {
            try {
                for (let sg of serializedGroups) {
                    this.addNewGroup(Group.fromSerializableGroup(sg, this.decorationFactory));
                }

                this.groups.sort(Group.sortByName);
            } catch (e) {
                vscode.window.showErrorMessage("LOAD Restoring bookmark groups failed (" + e + ")");
            }
        }

        let serializedBookmarks: Array<SerializableBookmark> | undefined
            = this.ctx.workspaceState.get(this.savedBookmarksKey);
        this.bookmarks = new Array<Bookmark>();
        if (typeof serializedBookmarks !== "undefined") {
            try {
                for (let sb of serializedBookmarks) {
                    let bookmark = Bookmark.fromSerializableBookMark(sb, this.decorationFactory);
                    this.addNewDecoratedBookmark(bookmark);
                }

                this.bookmarks.sort(Bookmark.sortByLocation);
            } catch (e) {
                vscode.window.showErrorMessage("LOAD Restoring bookmarks failed (" + e + ")");
            }
        }

        this.resetTempLists();
        this.activateGroup(activeGroupName);
        return true
    }

    private isEmpty() {
        return this.bookmarks.length === 0 && (this.groups.length === 1 && this.groups[0].name === defaultGroupName);
    }

    public saveState() {
        if (!this.savedBookmarksFilePath) {
            this.logger.log("SAVE has no target path...");
            return false
        }
        this.logger.log("SAVE to " + this.savedBookmarksFilePath);

        let serializedGroups = this.groups.map(group => SerializableGroup.fromGroup(group));
        this.ctx.workspaceState.update(this.savedGroupsKey, serializedGroups);

        let serializedBookmarks = this.bookmarks.map(bookmark => SerializableBookmark.fromBookmark(bookmark));
        this.ctx.workspaceState.update(this.savedBookmarksKey, serializedBookmarks);

        this.ctx.workspaceState.update(this.savedActiveGroupKey, this.activeGroup.name);
        this.ctx.workspaceState.update(this.savedHideInactiveGroupsKey, this.hideInactiveGroups);
        this.ctx.workspaceState.update(this.savedHideAllKey, this.hideAll);

        // save dict
        let obj: Record<string, any> = {};
        obj[this.savedBookmarksFileVersionKey] = this.savedBookmarksFileVersionValue;
        obj[this.savedGroupsKey] = serializedGroups;
        obj[this.savedBookmarksKey] = serializedBookmarks;
        obj[this.savedActiveGroupKey] = this.activeGroup.name;
        obj[this.savedHideInactiveGroupsKey] = this.hideInactiveGroups;
        obj[this.savedHideAllKey] = this.hideAll;
        let json = JSON.stringify(obj, null, 4);
        if (this.isEmpty()) {
            if (fs.existsSync(this.savedBookmarksFilePath)) {
                this.logger.log("SAVE empty bookmark -> deleting file");
                fs.unlinkSync(this.savedBookmarksFilePath);

                // delete .vscode if empty
                let dir = this.savedBookmarksFilePath.substring(0, this.savedBookmarksFilePath.lastIndexOf("/"));
                if (fs.existsSync(dir)) {
                    let files = fs.readdirSync(dir);
                    if (files.length === 0) {
                        this.logger.log("deleting directory: " + dir);
                        fs.rmdirSync(dir);
                    }
                }
            }
            return false
        }

        fs.mkdirSync(this.savedBookmarksFilePath.substring(0, this.savedBookmarksFilePath.lastIndexOf("/")), { recursive: true });
        this.lastSaveTimestamp = Date.now(); // put it here to avoid reloading on watcher event
        fs.writeFileSync(this.savedBookmarksFilePath, json);
        return true
    }

    public handleDecorationRemoved(decoration: TextEditorDecorationType) {
        this.removedDecorations.set(decoration, true);
    }

    public handleGroupDecorationUpdated(group: Group) {
        this.tempDocumentDecorations.clear();
        this.tempGroupBookmarks.get(group)?.forEach(bookmark => {
            bookmark.initDecoration();
        });
        this.updateDecorations();
        this.treeViewRefreshCallback();
    }

    public handleGroupDecorationSwitched(group: Group) {
        this.tempDocumentDecorations.clear();
        this.tempGroupBookmarks.get(group)?.forEach(bookmark => {
            bookmark.switchDecoration();
        });
        this.updateDecorations();
        this.treeViewRefreshCallback();
    }

    public handleBookmarkDecorationUpdated(bookmark: Bookmark) {
        this.tempDocumentDecorations.delete(bookmark.fsPath);
        this.updateDecorations();
    }

    public getGroups(): Array<Group> {
        return this.groups;
    }

    public getBookmarks(): Array<Bookmark> {
        return this.bookmarks;
    }

    public getActiveGroup(): Group {
        return this.activeGroup;
    }

    private updateDecorations() {
        for (let editor of vscode.window.visibleTextEditors) {
            this.updateEditorDecorations(editor);
        }

        this.removedDecorations.clear();
    }

    public getGroupByName(groupName: string): Group {
        for (let g of this.groups) {
            if (g.name === groupName) {
                return g;
            }
        }

        return this.activeGroup;
    }

    public updateEditorDecorations(textEditor: TextEditor | undefined) {
        if (typeof textEditor === "undefined") {
            return;
        }

        let fsPath = textEditor.document.uri.fsPath;
        let editorDecorations = this.getTempDocumentDecorationsList(fsPath);

        for (let [removedDecoration, b] of this.removedDecorations) {
            if (editorDecorations.has(removedDecoration)) {
                continue;
            }

            editorDecorations.set(removedDecoration, []);
        }

        for (let [decoration, ranges] of editorDecorations) {
            textEditor.setDecorations(decoration, ranges);
        }
    }

    public onEditorDocumentChanged(event: TextDocumentChangeEvent) {
        let fsPath = event.document.uri.fsPath;
        let fileBookmarkList = this.getTempDocumentBookmarkList(fsPath);

        if (fileBookmarkList.length === 0) {
            return;
        }

        let bookmarksChanged = false;

        for (let change of event.contentChanges) {
            let newLineCount = this.getNlCount(change.text);

            let oldFirstLine = change.range.start.line;
            let oldLastLine = change.range.end.line;
            let oldLineCount = oldLastLine - oldFirstLine;

            if (newLineCount === oldLineCount) {
                let updateCount = this.updateBookmarkLineTextInRange(
                    event.document,
                    fileBookmarkList,
                    oldFirstLine,
                    oldLastLine
                );
                if (updateCount > 0) {
                    this.treeViewRefreshCallback();
                }
                continue;
            }


            if (newLineCount > oldLineCount) {
                let shiftDownBy = newLineCount - oldLineCount;
                let newLastLine = oldFirstLine + newLineCount;

                let firstLinePrefix = event.document.getText(
                    new Range(oldFirstLine, 0, oldFirstLine, change.range.start.character)
                );
                let isFirstLinePrefixEmpty = firstLinePrefix.trim() === "";

                let shiftDownFromLine = (isFirstLinePrefixEmpty ? oldFirstLine : oldFirstLine + 1);

                for (let bookmark of fileBookmarkList) {
                    if (bookmark.lineNumber >= shiftDownFromLine) {
                        bookmark.lineNumber += shiftDownBy;
                        bookmarksChanged = true;
                    }

                    if (bookmark.lineNumber >= oldFirstLine && bookmark.lineNumber <= newLastLine) {
                        this.updateBookmarkLineText(event.document, bookmark);
                        this.treeViewRefreshCallback();
                    }
                }
                continue;
            }


            if (newLineCount < oldLineCount) {
                let shiftUpBy = oldLineCount - newLineCount;
                let newLastLine = oldFirstLine + newLineCount;

                let firstLinePrefix = event.document.getText(
                    new Range(oldFirstLine, 0, oldFirstLine, change.range.start.character)
                );
                let isFirstLineBookkmarkDeletable = firstLinePrefix.trim() === "";

                if (!isFirstLineBookkmarkDeletable) {
                    let firstLineBookmark = fileBookmarkList.find(bookmark => bookmark.lineNumber === oldFirstLine);
                    if (typeof firstLineBookmark === "undefined") {
                        isFirstLineBookkmarkDeletable = true;
                    }
                }

                let deleteFromLine = (isFirstLineBookkmarkDeletable ? oldFirstLine : oldFirstLine + 1);
                let shiftFromLine = deleteFromLine + shiftUpBy;

                for (let bookmark of fileBookmarkList) {
                    if (bookmark.lineNumber < oldFirstLine) {
                        continue;
                    }

                    if (bookmark.lineNumber >= deleteFromLine && bookmark.lineNumber < shiftFromLine) {
                        this.deleteBookmark(bookmark);
                        bookmarksChanged = true;
                        continue;
                    }

                    if (bookmark.lineNumber >= shiftFromLine) {
                        bookmark.lineNumber -= shiftUpBy;
                        bookmarksChanged = true;
                    }

                    if (bookmark.lineNumber >= oldFirstLine && bookmark.lineNumber <= newLastLine) {
                        this.updateBookmarkLineText(event.document, bookmark);
                        this.treeViewRefreshCallback();
                    }
                }
                continue;
            }
        }

        if (bookmarksChanged) {
            this.tempDocumentDecorations.delete(fsPath);
            this.saveState();
            this.updateDecorations();
            this.treeViewRefreshCallback();
        }
    }

    private getTempDocumentBookmarkList(fsPath: string): Array<Bookmark> {
        let list = this.tempDocumentBookmarks.get(fsPath);

        if (typeof list !== "undefined") {
            return list;
        }

        list = this.bookmarks.filter((bookmark) => { return bookmark.fsPath === fsPath; });
        this.tempDocumentBookmarks.set(fsPath, list);

        return list;
    }

    private getTempGroupBookmarkList(group: Group): Array<Bookmark> {
        let list = this.tempGroupBookmarks.get(group);

        if (typeof list !== "undefined") {
            return list;
        }

        list = this.bookmarks.filter((bookmark) => { return bookmark.group === group; });
        this.tempGroupBookmarks.set(group, list);

        return list;
    }

    private getTempDocumentDecorationsList(fsPath: string): Map<TextEditorDecorationType, Array<Range>> {
        let editorDecorations = this.tempDocumentDecorations.get(fsPath);

        if (typeof editorDecorations !== "undefined") {
            return editorDecorations;
        }

        let lineDecorations = new Map<number, TextEditorDecorationType>();
        let fileBookmarks = this.bookmarks
            .filter((bookmark) => {
                return bookmark.fsPath === fsPath && bookmark.getDecoration !== null;
            });

        fileBookmarks.filter(bookmark => bookmark.group === this.activeGroup)
            .forEach(bookmark => {
                let decoration = bookmark.getDecoration();
                if (decoration !== null) {
                    lineDecorations.set(bookmark.lineNumber, decoration);
                }
            });

        fileBookmarks.filter(bookmark => bookmark.group !== this.activeGroup)
            .forEach((bookmark) => {
                let decoration = bookmark.getDecoration();
                if (decoration !== null) {
                    if (!lineDecorations.has(bookmark.lineNumber)) {
                        lineDecorations.set(bookmark.lineNumber, decoration);
                    } else {
                        this.handleDecorationRemoved(decoration);
                    }
                }
            });

        editorDecorations = new Map<TextEditorDecorationType, Range[]>();
        for (let [lineNumber, decoration] of lineDecorations) {
            let ranges = editorDecorations.get(decoration);
            if (typeof ranges === "undefined") {
                ranges = new Array<Range>();
                editorDecorations.set(decoration, ranges);
            }

            ranges.push(new Range(lineNumber, 0, lineNumber, 0));
        }

        this.tempDocumentDecorations.set(fsPath, editorDecorations);

        return editorDecorations;
    }

    private resetTempLists() {
        this.tempDocumentBookmarks.clear();
        this.tempGroupBookmarks.clear();
        this.tempDocumentDecorations.clear();
    }

    private updateBookmarkLineTextInRange(
        document: TextDocument,
        bookmarks: Array<Bookmark>,
        firstLine: number,
        lastLine: number
    ): number {
        let updateCount = 0;
        bookmarks.filter(bookmark => {
            return bookmark.lineNumber >= firstLine && bookmark.lineNumber <= lastLine;
        }).forEach(bookmark => {
            this.updateBookmarkLineText(document, bookmark);
            updateCount++;
        });
        return updateCount;
    }

    private updateBookmarkLineText(document: TextDocument, bookmark: Bookmark) {
        let line = document.lineAt(bookmark.lineNumber);
        bookmark.characterNumber = Math.min(bookmark.characterNumber, line.range.end.character);
        bookmark.lineText = line.text.trim();
    }

    public actionDeleteOneBookmark(bookmark: Bookmark) {
        this.deleteBookmark(bookmark);
        this.saveState();
        this.updateDecorations();
        this.treeViewRefreshCallback();
    }

    public deleteBookmarksOfFile(fsPath: string, group: Group | null) {
        this.bookmarks
            .filter(b => (b.fsPath === fsPath && (group === null || group === b.group)))
            .forEach(b => this.deleteBookmark(b));
        this.saveState();
        this.updateDecorations();
        this.treeViewRefreshCallback();
    }

    private deleteBookmark(bookmark: Bookmark) {
        let index = this.bookmarks.indexOf(bookmark);
        if (index < 0) {
            return;
        }

        this.bookmarks.splice(index, 1);

        this.tempDocumentBookmarks.delete(bookmark.fsPath);
        this.tempDocumentDecorations.delete(bookmark.fsPath);
        this.tempGroupBookmarks.delete(bookmark.group);
        let bookmarkDecoration = bookmark.getDecoration();
        if (bookmarkDecoration !== null) {
            this.handleDecorationRemoved(bookmarkDecoration);
            this.handleDecorationRemoved(bookmark.group.decoration);
        }
    }

    public relabelBookmark(bookmark: Bookmark) {
        let defaultQuickInputText = bookmark.label ?? '';

        vscode.window.showInputBox({
            placeHolder: "new bookmark label",
            prompt: "Enter new bookmark label",
            value: defaultQuickInputText,
            valueSelection: [0, defaultQuickInputText.length],
        }).then(input => {
            if (typeof input === "undefined") {
                return;
            }

            let newLabel: string | undefined = input.trim();

            if (newLabel === defaultQuickInputText) {
                return;
            }

            if (newLabel.length === 1) {
                let existingBookmark = this.getTempDocumentBookmarkList(bookmark.fsPath)
                    .find((bm) => {
                        return bm.group === bookmark.group
                            && typeof bm.label !== "undefined"
                            && bm.label === newLabel;
                    });

                if (typeof existingBookmark !== "undefined") {
                    this.deleteBookmark(existingBookmark);
                }
            }

            if (newLabel.length === 0) {
                newLabel = undefined;
            }

            let newBookmark = new Bookmark(
                bookmark.fsPath,
                bookmark.lineNumber,
                bookmark.characterNumber,
                newLabel,
                bookmark.lineText,
                bookmark.group,
                this.decorationFactory
            );

            this.deleteBookmark(bookmark);

            this.addNewDecoratedBookmark(newBookmark);
            this.bookmarks.sort(Bookmark.sortByLocation);

            this.tempDocumentDecorations.delete(bookmark.fsPath);
            this.tempDocumentBookmarks.delete(bookmark.fsPath);
            this.tempGroupBookmarks.delete(this.activeGroup);
            this.saveState();
            this.updateDecorations();
            this.treeViewRefreshCallback();
        });
    }

    public renameGroup(group: Group) {
        let defaultQuickInputText = group.name;

        vscode.window.showInputBox({
            placeHolder: "new group name",
            prompt: "Enter new group name",
            value: defaultQuickInputText,
            valueSelection: [0, defaultQuickInputText.length],
        }).then(input => {
            if (typeof input === "undefined") {
                return;
            }

            let newName = input.trim();

            if (newName.length === 0) {
                return;
            }

            if (newName === defaultQuickInputText) {
                return;
            }

            if (newName.length > maxGroupNameLength) {
                vscode.window.showErrorMessage(
                    "ERROR: Choose a maximum " +
                    maxGroupNameLength +
                    " character long group name."
                );
                return;
            }

            if (typeof this.groups.find(g => {
                return g !== group && g.name === newName;
            }) !== "undefined") {
                vscode.window.showErrorMessage("ERROR: The entered bookmark group name is already in use");
                return;
            }

            group.name = newName;

            this.saveState();
            this.treeViewRefreshCallback();
            this.updateStatusBar();
        });
    }

    public editorActionToggleBookmark(textEditor: TextEditor) {
        if (textEditor.selections.length === 0) {
            return;
        }

        let documentFsPath = textEditor.document.uri.fsPath;
        for (let selection of textEditor.selections) {
            let lineNumber = selection.start.line;
            let characterNumber = selection.start.character;
            let lineText = textEditor.document.lineAt(lineNumber).text.trim();
            this.toggleBookmark(
                documentFsPath,
                lineNumber,
                characterNumber,
                lineText,
                this.activeGroup
            );
        }

        this.updateDecorations();
        this.treeViewRefreshCallback();
    }

    private toggleBookmark(
        fsPath: string,
        lineNumber: number,
        characterNumber: number,
        lineText: string,
        group: Group
    ) {
        let existingBookmark = this.getTempDocumentBookmarkList(fsPath)
            .find((bookmark) => { return bookmark.lineNumber === lineNumber && bookmark.group === group; });

        if (typeof existingBookmark !== "undefined") {
            this.deleteBookmark(existingBookmark);
            this.saveState();
            return;
        }

        let bookmark = new Bookmark(fsPath,
            lineNumber,
            characterNumber,
            undefined,
            lineText,
            group,
            this.decorationFactory
        );
        this.bookmarks.push(bookmark);
        this.bookmarks.sort(Bookmark.sortByLocation);

        this.tempDocumentBookmarks.delete(fsPath);
        this.tempDocumentDecorations.delete(fsPath);
        this.tempGroupBookmarks.delete(group);

        this.saveState();
    }

    public editorActionToggleLabeledBookmark(textEditor: TextEditor) {
        if (textEditor.selections.length === 0) {
            return;
        }

        let fsPath = textEditor.document.uri.fsPath;
        let lineNumber = textEditor.selection.start.line;

        let existingBookmark = this.getTempDocumentBookmarkList(fsPath)
            .find((bookmark) => { return bookmark.lineNumber === lineNumber && bookmark.group === this.activeGroup; });

        if (typeof existingBookmark !== "undefined") {
            this.deleteBookmark(existingBookmark);
            this.saveState();
            this.updateDecorations();
            this.treeViewRefreshCallback();
            return;
        }

        let selectedText = textEditor.document.getText(textEditor.selection).trim();
        let firstNlPos = selectedText.indexOf("\n");
        if (firstNlPos >= 0) {
            selectedText = selectedText.substring(0, firstNlPos).trim();
        }
        selectedText = selectedText.replace(/[\s\t\r\n]+/, " ").replace("@", "@\u200b");

        vscode.window.showInputBox({
            placeHolder: "label or label@@group or @@group",
            prompt: "Enter label and/or group to be created",
            value: selectedText,
            valueSelection: [0, selectedText.length],
        }).then(input => {
            if (typeof input === "undefined") {
                return;
            }

            input = input.trim();
            if (input === "") {
                return;
            }

            let label = "";
            let groupName = "";

            let separatorPos = input.indexOf('@@');
            if (separatorPos >= 0) {
                label = input.substring(0, separatorPos).trim();
                groupName = input.substring(separatorPos + 2).trim();
            } else {
                label = input.replace("@\u200b", "@");
            }

            if (label === "" && groupName === "") {
                return;
            }

            if (groupName.length > maxGroupNameLength) {
                vscode.window.showErrorMessage(
                    "ERROR: Choose a maximum " +
                    maxGroupNameLength +
                    " character long group name."
                );
                return;
            }

            if (groupName !== "") {
                this.activateGroup(groupName);
            }

            if (label.length === 1) {
                let existingLabeledBookmark = this.getTempDocumentBookmarkList(fsPath)
                    .find((bookmark) => {
                        return bookmark.group === this.activeGroup
                            && typeof bookmark.label !== "undefined"
                            && bookmark.label === label;
                    });

                if (typeof existingLabeledBookmark !== "undefined") {
                    this.deleteBookmark(existingLabeledBookmark);
                }
            }

            if (label !== "") {
                let characterNumber = textEditor.selection.start.character;
                let lineText = textEditor.document.lineAt(lineNumber).text.trim();

                let bookmark = new Bookmark(
                    fsPath,
                    lineNumber,
                    characterNumber,
                    label,
                    lineText,
                    this.activeGroup,
                    this.decorationFactory
                );
                this.addNewDecoratedBookmark(bookmark);
                this.bookmarks.sort(Bookmark.sortByLocation);
            }

            this.tempDocumentDecorations.delete(fsPath);
            this.tempDocumentBookmarks.delete(fsPath);
            this.tempGroupBookmarks.delete(this.activeGroup);
            this.saveState();
            this.updateDecorations();
            this.treeViewRefreshCallback();
        });
    }

    public editorActionnavigateToNextBookmark(textEditor: TextEditor) {
        if (textEditor.selections.length === 0) {
            return;
        }

        let documentFsPath = textEditor.document.uri.fsPath;
        let lineNumber = textEditor.selection.start.line;

        let nextBookmark = this.nextBookmark(documentFsPath, lineNumber);
        if (typeof nextBookmark === "undefined") {
            return;
        }

        this.jumpToBookmark(nextBookmark);
    }

    public nextBookmark(fsPath: string, line: number): Bookmark | undefined {
        let brokenBookmarkCount = 0;

        let groupBookmarkList = this.getTempGroupBookmarkList(this.activeGroup);

        let firstCandidate = groupBookmarkList.find((bookmark, i) => {
            if (bookmark.failedJump) {
                brokenBookmarkCount++;
                return false;
            }

            let fileComparisonResult = bookmark.fsPath.localeCompare(fsPath);

            if (fileComparisonResult < 0) {
                return false;
            }
            if (fileComparisonResult > 0) {
                return true;
            }

            return line < bookmark.lineNumber;
        });

        if (typeof firstCandidate === "undefined" && groupBookmarkList.length > 0) {
            if (groupBookmarkList.length > brokenBookmarkCount) {
                for (let bookmark of groupBookmarkList) {
                    if (!bookmark.failedJump) {
                        return bookmark;
                    }
                }
            }
            vscode.window.showWarningMessage("ERROR: All bookmarks are broken, time for some cleanup");
        }

        return firstCandidate;
    }

    public editorActionNavigateToPreviousBookmark(textEditor: TextEditor) {
        if (textEditor.selections.length === 0) {
            return;
        }

        let documentFsPath = textEditor.document.uri.fsPath;
        let lineNumber = textEditor.selection.start.line;

        let previousBookmark = this.previousBookmark(documentFsPath, lineNumber);
        if (typeof previousBookmark === "undefined") {
            return;
        }

        this.jumpToBookmark(previousBookmark);
    }

    public previousBookmark(fsPath: string, line: number): Bookmark | undefined {
        let brokenBookmarkCount = 0;

        let groupBookmarkList = this.getTempGroupBookmarkList(this.activeGroup);

        let firstCandidate: Bookmark | undefined;

        for (let i = groupBookmarkList.length - 1; i >= 0; i--) {
            let bookmark = groupBookmarkList[i];

            if (bookmark.failedJump) {
                brokenBookmarkCount++;
                continue;
            }

            let fileComparisonResult = bookmark.fsPath.localeCompare(fsPath);
            if (fileComparisonResult > 0) {
                continue;
            }

            if (fileComparisonResult < 0) {
                firstCandidate = bookmark;
                break;
            }

            if (bookmark.lineNumber < line) {
                firstCandidate = bookmark;
                break;
            }
        }

        if (typeof firstCandidate === "undefined" && groupBookmarkList.length > 0) {
            if (groupBookmarkList.length > brokenBookmarkCount) {
                for (let i = groupBookmarkList.length - 1; i >= 0; i--) {
                    if (!groupBookmarkList[i].failedJump) {
                        return groupBookmarkList[i];
                    }
                }
            }
            vscode.window.showWarningMessage("ERROR: All bookmarks are broken, time for some cleanup");
        }

        return firstCandidate;
    }

    public actionExpandSelectionToNextBookmark(editor: TextEditor) {
        let bookmarks = this.getTempDocumentBookmarkList(editor.document.uri.fsPath);
        if (typeof bookmarks === "undefined") {
            return;
        }

        let selection = editor.selection;

        let endLineRange = editor.document.lineAt(selection.end.line).range;
        let selectionEndsAtLineEnd = selection.end.character >= endLineRange.end.character;

        let searchFromLine = selection.end.line;
        if (selectionEndsAtLineEnd) {
            searchFromLine++;
        }

        let nextBookmark = bookmarks.find(
            bookmark => {
                return bookmark.group === this.activeGroup && bookmark.lineNumber >= searchFromLine;
            }
        );

        if (typeof nextBookmark === "undefined") {
            return;
        }

        let newSelectionEndCharacter: number;
        if (nextBookmark.lineNumber === selection.end.line) {
            newSelectionEndCharacter = endLineRange.end.character;
        } else {
            newSelectionEndCharacter = 0;
        }

        editor.selection = new Selection(
            selection.start.line,
            selection.start.character,
            nextBookmark.lineNumber,
            newSelectionEndCharacter
        );

        editor.revealRange(new Range(
            nextBookmark.lineNumber,
            newSelectionEndCharacter,
            nextBookmark.lineNumber,
            newSelectionEndCharacter
        ));
    }

    public actionExpandSelectionToPreviousBookmark(editor: TextEditor) {
        let bookmarks = this.getTempDocumentBookmarkList(editor.document.uri.fsPath);
        if (typeof bookmarks === "undefined") {
            return;
        }

        let selection = editor.selection;

        let startLineRange = editor.document.lineAt(selection.start.line).range;
        let selectionStartsAtLineStart = selection.start.character === 0;

        let searchFromLine = selection.start.line;
        if (selectionStartsAtLineStart) {
            searchFromLine--;
        }

        let nextBookmark: Bookmark | undefined;
        for (let i = bookmarks.length - 1; i >= 0; i--) {
            if (bookmarks[i].group === this.activeGroup && bookmarks[i].lineNumber <= searchFromLine) {
                nextBookmark = bookmarks[i];
                break;
            }
        }

        if (typeof nextBookmark === "undefined") {
            return;
        }

        let newSelectionStartCharacter: number;
        if (nextBookmark.lineNumber === selection.start.line) {
            newSelectionStartCharacter = 0;
        } else {
            newSelectionStartCharacter = editor.document.lineAt(nextBookmark.lineNumber).range.end.character;
        }

        editor.selection = new Selection(
            nextBookmark.lineNumber,
            newSelectionStartCharacter,
            selection.end.line,
            selection.end.character
        );

        editor.revealRange(new Range(
            nextBookmark.lineNumber,
            newSelectionStartCharacter,
            nextBookmark.lineNumber,
            newSelectionStartCharacter
        ));
    }

    public actionNavigateToBookmark() {
        this.navigateBookmarkList(
            "navigate to bookmark",
            this.getTempGroupBookmarkList(this.activeGroup),
            false
        );
    }


    public actionNavigateToBookmarkOfAnyGroup() {
        this.navigateBookmarkList(
            "navigate to bookmark of any bookmark group",
            this.bookmarks,
            true
        );
    }

    private navigateBookmarkList(placeholderText: string, bookmarks: Array<Bookmark>, withGroupNames: boolean) {
        let currentEditor = vscode.window.activeTextEditor;
        let currentDocument: TextDocument;
        let currentSelection: Selection;
        if (typeof currentEditor !== "undefined") {
            currentSelection = currentEditor.selection;
            currentDocument = currentEditor.document;
        }
        let didNavigateBeforeClosing = false;

        let pickItems = bookmarks.map(
            bookmark => BookmarkPickItem.fromBookmark(bookmark, withGroupNames)
        );

        vscode.window.showQuickPick(
            pickItems,
            {
                canPickMany: false,
                matchOnDescription: true,
                placeHolder: placeholderText,
                ignoreFocusOut: true,
                onDidSelectItem: (selected: BookmarkPickItem) => {
                    didNavigateBeforeClosing = true;
                    this.jumpToBookmark(selected.bookmark, true);
                }
            }
        ).then(selected => {
            if (typeof selected !== "undefined") {
                this.jumpToBookmark(selected.bookmark);
                return;
            }

            if (!didNavigateBeforeClosing) {
                return;
            }

            if (
                typeof currentDocument === "undefined"
                || typeof currentSelection === "undefined"
                || currentDocument === null
                || currentSelection === null) {
                return;
            }

            vscode.window.showTextDocument(currentDocument, { preview: false }).then(
                textEditor => {
                    try {
                        textEditor.selection = currentSelection;
                        textEditor.revealRange(new Range(currentSelection.start, currentSelection.end));
                    } catch (e) {
                        vscode.window.showWarningMessage("ERROR: Failed to navigate to origin (1): " + e);
                        return;
                    }
                },
                rejectReason => {
                    vscode.window.showWarningMessage("ERROR: Failed to navigate to origin (2): " + rejectReason.message);
                }
            );
        });
    }

    public actionSetGroupIconShape() {
        let iconText = this.activeGroup.iconText;

        let shapePickItems = new Array<ShapePickItem>();
        for (let [label, id] of this.shapes) {
            label = (this.activeGroup.shape === id ? "● " : "◌ ") + label;
            shapePickItems.push(new ShapePickItem(id, iconText, label, "vector", ""));
        }

        for (let [name, marker] of this.unicodeMarkers) {
            let label = (this.activeGroup.shape === "unicode" && this.activeGroup.iconText === marker ? "● " : "◌ ");
            label += marker + " " + name;
            shapePickItems.push(new ShapePickItem("unicode", marker, label, "unicode", ""));
        }

        vscode.window.showQuickPick(
            shapePickItems,
            {
                canPickMany: false,
                matchOnDescription: false,
                placeHolder: "select bookmark group icon shape"
            }
        ).then(selected => {
            if (typeof selected !== "undefined") {
                let shape = (selected as ShapePickItem).shape;
                let iconText = (selected as ShapePickItem).iconText;
                this.activeGroup.setShapeAndIconText(shape, iconText);
                this.saveState();
            }
        });
    }

    public actionSetGroupIconColor() {
        let colorPickItems = new Array<ColorPickItem>();
        for (let [name, color] of this.colors) {
            let label = (this.activeGroup.color === color ? "● " : "◌ ") + name;

            colorPickItems.push(new ColorPickItem(color, label, "", ""));
        }

        vscode.window.showQuickPick(
            colorPickItems,
            {
                canPickMany: false,
                matchOnDescription: false,
                placeHolder: "select bookmark group icon color"
            }
        ).then(selected => {
            if (typeof selected !== "undefined") {
                let color = (selected as ColorPickItem).color;
                this.activeGroup.setColor(color);
                this.saveState();
            }
        });
    }

    public actionSelectGroup() {
        let pickItems = this.groups.map(
            group => GroupPickItem.fromGroup(group, this.getTempGroupBookmarkList(group).length)
        );

        vscode.window.showQuickPick(
            pickItems,
            {
                canPickMany: false,
                matchOnDescription: false,
                placeHolder: "select bookmark group"
            }
        ).then(selected => {
            if (typeof selected !== "undefined") {
                this.setActiveGroup((selected as GroupPickItem).group.name);
            }
        });
    }

    public setActiveGroup(groupName: string) {
        this.activateGroup(groupName);
        this.updateDecorations();
        this.saveState();
    }

    public actionAddGroup() {
        vscode.window.showInputBox({
            placeHolder: "group name",
            prompt: "Enter group name to create or switch to"
        }).then(groupName => {
            if (typeof groupName === "undefined") {
                return;
            }

            groupName = groupName.trim();
            if (groupName === "") {
                return;
            }

            if (groupName.length > maxGroupNameLength) {
                vscode.window.showErrorMessage(
                    "ERROR: Choose a maximum " +
                    maxGroupNameLength +
                    " character long group name."
                );
                return;
            }

            this.activateGroup(groupName);
            this.updateDecorations();
            this.saveState();
            this.treeViewRefreshCallback();
        });
    }

    public actionDeleteGroup() {
        let pickItems = this.groups.map(
            group => GroupPickItem.fromGroup(group, this.getTempGroupBookmarkList(group).length)
        );

        vscode.window.showQuickPick(
            pickItems,
            {
                canPickMany: true,
                matchOnDescription: false,
                placeHolder: "select bookmark groups to be deleted"
            }
        ).then(selecteds => {
            if (typeof selecteds !== "undefined") {
                this.deleteGroups(selecteds.map(pickItem => pickItem.group));
            }
        });
    }

    public actionDeleteOneGroup(group: Group) {
        this.deleteGroups([group]);
    }

    private deleteGroups(groups: Array<Group>) {
        let wasActiveGroupDeleted = false;

        for (let group of groups) {
            wasActiveGroupDeleted ||= (group === this.activeGroup);

            this.getTempGroupBookmarkList(group).forEach(bookmark => {
                this.deleteBookmark(bookmark);
            });

            let index = this.groups.indexOf(group);
            if (index >= 0) {
                this.groups.splice(index, 1);
            }

            group.removeDecorations();
            this.tempGroupBookmarks.delete(group);
        }

        if (this.groups.length === 0) {
            this.activateGroup(defaultGroupName);
        } else if (wasActiveGroupDeleted) {
            this.activateGroup(this.groups[0].name);
        }

        this.updateDecorations();
        this.saveState();
        this.treeViewRefreshCallback();
    }

    public actionDeleteBookmark() {
        let currentEditor = vscode.window.activeTextEditor;
        let currentDocument: TextDocument;
        let currentSelection: Selection;
        if (typeof currentEditor !== "undefined") {
            currentSelection = currentEditor.selection;
            currentDocument = currentEditor.document;
        }
        let didNavigateBeforeClosing = false;

        let pickItems = this.getTempGroupBookmarkList(this.activeGroup).map(
            bookmark => BookmarkPickItem.fromBookmark(bookmark, false)
        );

        vscode.window.showQuickPick(
            pickItems,
            {
                canPickMany: true,
                matchOnDescription: false,
                placeHolder: "select bookmarks to be deleted",
                ignoreFocusOut: true,
                onDidSelectItem: (selected: BookmarkPickItem) => {
                    didNavigateBeforeClosing = true;
                    this.jumpToBookmark(selected.bookmark, true);
                }
            }
        ).then(selecteds => {
            if (typeof selecteds !== "undefined") {
                for (let selected of selecteds) {
                    this.deleteBookmark(selected.bookmark);
                }

                this.updateDecorations();
                this.saveState();
                this.treeViewRefreshCallback();
            }

            if (!didNavigateBeforeClosing) {
                return;
            }

            if (
                typeof currentDocument === "undefined"
                || typeof currentSelection === "undefined"
                || currentDocument === null
                || currentSelection === null) {
                return;
            }

            vscode.window.showTextDocument(currentDocument, { preview: false }).then(
                textEditor => {
                    try {
                        textEditor.selection = currentSelection;
                        textEditor.revealRange(new Range(currentSelection.start, currentSelection.end));
                    } catch (e) {
                        vscode.window.showWarningMessage("ERROR: Failed to navigate to origin (1): " + e);
                        return;
                    }
                },
                rejectReason => {
                    vscode.window.showWarningMessage("ERROR: Failed to navigate to origin (2): " + rejectReason.message);
                }
            );
        });
    }

    public actionToggleHideAll() {
        this.setHideAll(!this.hideAll);
        this.updateDecorations();
        this.saveState();
    }

    public actionToggleHideInactiveGroups() {
        this.setHideInactiveGroups(!this.hideInactiveGroups);
        this.updateDecorations();
        this.saveState();
    }

    public actionClearFailedJumpFlags() {
        let clearedFlagCount = 0;

        for (let bookmark of this.bookmarks) {
            if (bookmark.failedJump) {
                bookmark.failedJump = false;
                clearedFlagCount++;
            }
        }

        vscode.window.showInformationMessage("ERROR: Cleared broken bookmark flags: " + clearedFlagCount);
        this.saveState();
    }

    public actionMoveBookmarksFromActiveGroup() {
        let pickItems = this.groups.filter(
            g => g !== this.activeGroup
        ).map(
            group => GroupPickItem.fromGroup(group, this.getTempGroupBookmarkList(group).length)
        );

        if (pickItems.length === 0) {
            vscode.window.showWarningMessage("ERROR: There is no other group to move bookmarks into");
            return;
        }

        vscode.window.showQuickPick(
            pickItems,
            {
                canPickMany: false,
                matchOnDescription: false,
                placeHolder: "select destination group to move bookmarks into"
            }
        ).then(selected => {
            if (typeof selected !== "undefined") {
                this.moveBookmarksBetween(this.activeGroup, selected.group);
            }
        });
    }

    private moveBookmarksBetween(src: Group, dst: Group) {
        let pickItems = this.getTempGroupBookmarkList(src).map(
            bookmark => BookmarkPickItem.fromBookmark(bookmark, false)
        );

        vscode.window.showQuickPick(
            pickItems,
            {
                canPickMany: true,
                matchOnDescription: false,
                placeHolder: "move bookmarks from " + src.name + " into " + dst.name,
                ignoreFocusOut: true,
            }
        ).then(selecteds => {
            if (typeof selecteds !== "undefined") {
                for (let selected of selecteds) {
                    let oldBookmark = selected.bookmark;

                    this.deleteBookmark(oldBookmark);

                    let newBookmark = new Bookmark(
                        oldBookmark.fsPath,
                        oldBookmark.lineNumber,
                        oldBookmark.characterNumber,
                        oldBookmark.label,
                        oldBookmark.lineText,
                        dst,
                        this.decorationFactory
                    );

                    this.addNewDecoratedBookmark(newBookmark);

                    this.tempDocumentDecorations.delete(newBookmark.fsPath);
                    this.tempDocumentBookmarks.delete(newBookmark.fsPath);
                    this.tempGroupBookmarks.delete(newBookmark.group);
                }

                this.bookmarks.sort(Bookmark.sortByLocation);

                this.saveState();
                this.updateDecorations();
                this.treeViewRefreshCallback();
            }
        });
    }

    public readSettings() {
        this.logger.log("SETTINGS parsing");

        let defaultDefaultShape = "bookmark";

        let config = vscode.workspace.getConfiguration(this.configRoot);

        if (config.has(this.configKeyColors)) {
            try {
                let configColors = (config.get(this.configKeyColors) as Array<Array<string>>);
                this.colors = new Map<string, string>();
                for (let [index, value] of configColors) {
                    this.colors.set(index, this.decorationFactory.normalizeColorFormat(value));
                }
            } catch (e) {
                vscode.window.showWarningMessage("SETTINGS: Error reading bookmark color setting");
            }
        }

        if (config.has(this.configKeyUnicodeMarkers)) {
            try {
                let configMarkers = (config.get(this.configKeyUnicodeMarkers) as Array<Array<string>>);
                this.unicodeMarkers = new Map<string, string>();
                for (let [index, value] of configMarkers) {
                    this.unicodeMarkers.set(index, value);
                }
            } catch (e) {
                vscode.window.showWarningMessage("SETTINGS: Error reading bookmark unicode marker setting");
            }
        }

        if (config.has(this.configKeyDefaultShape)) {
            let configDefaultShape = (config.get(this.configKeyDefaultShape) as string) ?? "";
            if (this.shapes.has(configDefaultShape)) {
                this.defaultShape = configDefaultShape;
            } else {
                vscode.window.showWarningMessage("SETTINGS: Error reading bookmark default shape setting, using default");
                this.defaultShape = defaultDefaultShape;
            }
        } else {
            this.defaultShape = defaultDefaultShape;
        }

        let configOverviewRulerLane = (config.get(this.configOverviewRulerLane) as string) ?? "center";
        let previousOverviewRulerLane = this.decorationFactory.overviewRulerLane;
        let newOverviewRulerLane: OverviewRulerLane | undefined;
        switch (configOverviewRulerLane) {
            case "center": newOverviewRulerLane = OverviewRulerLane.Center; break;
            case "full": newOverviewRulerLane = OverviewRulerLane.Full; break;
            case "left": newOverviewRulerLane = OverviewRulerLane.Left; break;
            case "right": newOverviewRulerLane = OverviewRulerLane.Right; break;
            default:
                newOverviewRulerLane = undefined;
        }

        let newLineEndLabelType = (config.get(this.configLineEndLabelType) as string) ?? "bordered";
        let previousLineEndLabelType = this.decorationFactory.lineEndLabelType;

        if (
            (typeof previousOverviewRulerLane === "undefined") !== (typeof newOverviewRulerLane === "undefined")
            || previousOverviewRulerLane !== newOverviewRulerLane
            || (typeof previousLineEndLabelType === "undefined") !== (typeof newLineEndLabelType === "undefined")
            || previousLineEndLabelType !== newLineEndLabelType
        ) {
            this.decorationFactory.overviewRulerLane = newOverviewRulerLane;
            this.decorationFactory.lineEndLabelType = newLineEndLabelType;
            this.groups.forEach(group => group.redoDecorations());
            this.bookmarks.forEach(bookmark => bookmark.initDecoration());
        }
    }

    public async onFilesRenamed(fileRenamedEvent: FileRenameEvent) {
        let changedFiles = new Map<string, boolean>();

        for (let rename of fileRenamedEvent.files) {
            let stat = await vscode.workspace.fs.stat(rename.newUri);
            let oldFsPath = rename.oldUri.fsPath;
            let newFsPath = rename.newUri.fsPath;

            if ((stat.type & vscode.FileType.Directory) > 0) {
                for (let bookmark of this.bookmarks) {
                    if (bookmark.fsPath.startsWith(oldFsPath)) {
                        let originalBookmarkFsPath = bookmark.fsPath;
                        bookmark.fsPath = newFsPath + bookmark.fsPath.substring(oldFsPath.length);
                        changedFiles.set(originalBookmarkFsPath, true);
                        changedFiles.set(bookmark.fsPath, true);
                    }
                }
            } else {
                for (let bookmark of this.bookmarks) {
                    if (bookmark.fsPath === oldFsPath) {
                        bookmark.fsPath = newFsPath;
                        changedFiles.set(oldFsPath, true);
                        changedFiles.set(newFsPath, true);
                    }
                }
            }
        }

        for (let [changedFile, b] of changedFiles) {
            this.tempDocumentBookmarks.delete(changedFile);
            this.tempDocumentDecorations.delete(changedFile);
        }

        if (changedFiles.size > 0) {
            this.saveState();
            this.updateDecorations();
            this.treeViewRefreshCallback();
        }
    }

    public async onFilesDeleted(fileDeleteEvent: FileDeleteEvent) {
        for (let uri of fileDeleteEvent.files) {
            let deletedFsPath = uri.fsPath;

            let changesWereMade = false;
            for (let bookmark of this.bookmarks) {
                if (bookmark.fsPath === deletedFsPath) {
                    this.deleteBookmark(bookmark);
                    changesWereMade = true;
                }
            }

            if (changesWereMade) {
                this.saveState();
                this.updateDecorations();
                this.treeViewRefreshCallback();
            }
        }
    }

    private updateStatusBar() {
        this.statusBarItem.text = "$(bookmark) "
            + this.activeGroup.name
            + ": "
            + this.getTempGroupBookmarkList(this.activeGroup).length;

        let hideStatus = "";
        if (this.hideAll) {
            hideStatus = ", all hidden";
        } else if (this.hideInactiveGroups) {
            hideStatus = ", inactive groups hidden";
        } else {
            hideStatus = ", all visible";
        }
        this.statusBarItem.tooltip = this.groups.length + " group(s)" + hideStatus;
    }

    private addNewGroup(group: Group) {
        group.onGroupDecorationUpdated(this.handleGroupDecorationUpdated.bind(this));
        group.onGroupDecorationSwitched(this.handleGroupDecorationSwitched.bind(this));
        group.onDecorationRemoved(this.handleDecorationRemoved.bind(this));
        group.initDecorations();
        this.groups.push(group);
    }

    private addNewDecoratedBookmark(bookmark: Bookmark) {
        bookmark.onBookmarkDecorationUpdated(this.handleBookmarkDecorationUpdated.bind(this));
        bookmark.onDecorationRemoved(this.handleDecorationRemoved.bind(this));
        bookmark.initDecoration();
        this.bookmarks.push(bookmark);
    }

    private activateGroup(name: string) {
        let newActiveGroup = this.ensureGroup(name);
        if (newActiveGroup === this.activeGroup) {
            return;
        }

        this.activeGroup.setIsActive(false);
        this.activeGroup = newActiveGroup;
        newActiveGroup.setIsActive(true);

        this.setGroupVisibilities();
        this.tempDocumentDecorations.clear();
    }

    private setGroupVisibilities() {
        this.groups.forEach(group => {
            group.setIsVisible(!this.hideAll && (!this.hideInactiveGroups || group.isActive));
        });
    }

    private ensureGroup(name: string): Group {
        let group = this.groups.find(
            (group) => {
                return group.name === name;
            });

        if (typeof group !== "undefined") {
            return group;
        }

        group = new Group(name, this.getLeastUsedColor(), this.defaultShape, name, this.decorationFactory);
        this.addNewGroup(group);
        this.groups.sort(Group.sortByName);

        return group;
    }

    private getLeastUsedColor(): string {
        if (this.colors.size < 1) {
            return this.fallbackColor;
        }

        let usages = new Map<string, number>();

        for (let [index, color] of this.colors) {
            usages.set(color, 0);
        }

        for (let group of this.groups) {
            let groupColor = group.getColor();
            if (usages.has(groupColor)) {
                usages.set(groupColor, (usages.get(groupColor) ?? 0) + 1);
            }
        }

        let minUsage = Number.MAX_SAFE_INTEGER;
        let leastUsedColor = "";

        for (let [key, value] of usages) {
            if (minUsage > value) {
                minUsage = value;
                leastUsedColor = key;
            }
        }

        return leastUsedColor;
    }

    private setHideInactiveGroups(hideInactiveGroups: boolean) {
        if (this.hideInactiveGroups === hideInactiveGroups) {
            return;
        }

        this.hideInactiveGroups = hideInactiveGroups;

        this.setGroupVisibilities();

        this.tempDocumentDecorations.clear();
    }

    private setHideAll(hideAll: boolean) {
        if (this.hideAll === hideAll) {
            return;
        }

        this.hideAll = hideAll;

        this.setGroupVisibilities();

        this.tempDocumentDecorations.clear();
    }

    private getNlCount(text: string) {
        let nlCount: number = 0;
        for (let c of text) {
            nlCount += (c === "\n") ? 1 : 0;
        }
        return nlCount;
    }

    private getFirstLine(text: string): string {
        let firstNewLinePos = text.indexOf("\n");
        if (firstNewLinePos < 0) {
            return text;
        }

        return text.substring(0, firstNewLinePos + 1);
    }

    private getLastLine(text: string): string {
        let lastNewLinePos = text.lastIndexOf("\n");
        if (lastNewLinePos < 0) {
            return text;
        }

        return text.substring(lastNewLinePos + 1);
    }

    public jumpToBookmark(bookmark: Bookmark, preview: boolean = false) {
        vscode.window.showTextDocument(vscode.Uri.file(bookmark.fsPath), { preview: preview, preserveFocus: preview }).then(
            textEditor => {
                try {
                    let range = new Range(
                        bookmark.lineNumber,
                        bookmark.characterNumber,
                        bookmark.lineNumber,
                        bookmark.characterNumber
                    );
                    textEditor.selection = new vscode.Selection(range.start, range.start);
                    textEditor.revealRange(range);
                } catch (e) {
                    bookmark.failedJump = true;
                    vscode.window.showWarningMessage("ERROR: Failed to navigate to bookmark (3): " + e);
                    return;
                }
                bookmark.failedJump = false;
            },
            rejectReason => {
                bookmark.failedJump = true;
                vscode.window.showWarningMessage("ERROR: Failed to navigate to bookmark (2): " + rejectReason.message);
            }
        );
    }

    public getNearestActiveBookmarkInFile(textEditor: TextEditor, group: Group | null): Bookmark | null {
        if (textEditor.selections.length === 0) {
            return null;
        }

        let fsPath = textEditor.document.uri.fsPath;
        let lineNumber = textEditor.selection.start.line;

        let nearestBeforeLine = -1;
        let nearestBefore: Bookmark | null = null;
        let nearestAfterline = Number.MAX_SAFE_INTEGER;
        let nearestAfter: Bookmark | null = null;

        this.getTempDocumentBookmarkList(fsPath)
            .filter(g => (group === null || g.group === group))
            .forEach(bookmark => {
                if (bookmark.lineNumber > nearestBeforeLine && bookmark.lineNumber <= lineNumber) {
                    nearestBeforeLine = bookmark.lineNumber;
                    nearestBefore = bookmark;
                }

                if (bookmark.lineNumber < nearestAfterline && bookmark.lineNumber >= lineNumber) {
                    nearestAfterline = bookmark.lineNumber;
                    nearestAfter = bookmark;
                }
            });

        if (nearestBefore === null && nearestAfter === null) {
            return null;
        }

        if (nearestBefore !== null && nearestAfter !== null) {
            if (lineNumber - nearestBeforeLine < nearestAfterline - lineNumber) {
                return nearestBefore;
            }

            return nearestAfter;
        }

        if (nearestBefore !== null) {
            return nearestBefore;
        }

        return nearestAfter;
    }
}