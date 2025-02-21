import { DecorationFactory } from "./decoration_factory";
import { TextEditorDecorationType, Uri, workspace } from "vscode";
import { SerializableBookmark } from "./serializable_bookmark";
import { Group } from "./group";
import * as path from "path";

export class Bookmark {
    public fsPath: string;
    public lineNumber: number;
    public characterNumber: number;
    public label?: string;
    public lineText: string;
    public failedJump: boolean;
    public isLineNumberChanged: boolean;
    public group: Group;
    public decorationFactory: DecorationFactory;

    private ownDecoration: TextEditorDecorationType | null;
    private bookmarkDecorationUpdatedHandler: (bookmark: Bookmark) => void;
    private decorationRemovedHandler: (decoration: TextEditorDecorationType) => void;

    constructor(
        fsPath: string,
        lineNumber: number,
        characterNumber: number,
        label: string | undefined,
        lineText: string,
        group: Group,
        decorationFactory: DecorationFactory
    ) {
        this.fsPath = fsPath;
        this.lineNumber = lineNumber;
        this.characterNumber = characterNumber;
        this.label = label;
        this.lineText = lineText;
        this.failedJump = false;
        this.isLineNumberChanged = false;
        this.group = group;
        this.decorationFactory = decorationFactory;
        this.ownDecoration = null;
        this.bookmarkDecorationUpdatedHandler = (bookmark: Bookmark) => { return; };
        this.decorationRemovedHandler = (decoration: TextEditorDecorationType) => { return; };
    }

    public static fromSerializableBookMark(
        serialized: SerializableBookmark,
        groupGetter: (groupName: string) => Group,
        decorationFactory: DecorationFactory
    ): Bookmark {
        const workspaceFolder = workspace.workspaceFolders?.[0]?.uri.fsPath;

        // Convert to absolute if the fsPath is relative to the workspace
        const absolutePath = workspaceFolder && !path.isAbsolute(serialized.fsPath)
            ? path.join(workspaceFolder, serialized.fsPath)
            : serialized.fsPath;

        return new Bookmark(
            absolutePath,
            serialized.lineNumber,
            serialized.characterNumber,
            serialized.label,
            serialized.lineText,
            groupGetter(serialized.groupName),
            decorationFactory
        );
    }

    public static sortByLocation(a: Bookmark, b: Bookmark): number {
        return a.fsPath.localeCompare(b.fsPath)
            || (a.lineNumber - b.lineNumber)
            || (a.characterNumber - b.characterNumber);
    }

    public resetIsLineNumberChangedFlag() {
        this.isLineNumberChanged = false;
    }

    public setLineAndCharacterNumbers(lineNumber: number, characterNumber: number) {
        this.characterNumber = characterNumber;

        if (lineNumber === this.lineNumber) {
            return;
        }

        this.lineNumber = lineNumber;
        this.isLineNumberChanged = true;
    }

    public getDecoration(): TextEditorDecorationType | null {
        if (this.group.isActive && this.group.isVisible) {
            return this.ownDecoration || this.group.getActiveDecoration();
        } else {
            return this.group.getActiveDecoration();
        }
    }

    public onBookmarkDecorationUpdated(fn: (bookmark: Bookmark) => void) {
        this.bookmarkDecorationUpdatedHandler = fn;
    }

    public onDecorationRemoved(fn: (decoration: TextEditorDecorationType) => void) {
        this.decorationRemovedHandler = fn;
    }

    public async initDecoration() {
        if (typeof this.label === "undefined") {
            return;
        }

        let previousDecoration = this.ownDecoration;
        let tempSvg: Uri;

        [this.ownDecoration, tempSvg] = await this.decorationFactory.create(
            this.group.shape,
            this.group.color,
            this.group.iconText,
            this.label
        );

        if (previousDecoration !== null) {
            this.decorationRemovedHandler(previousDecoration);
        }

        this.bookmarkDecorationUpdatedHandler(this);
    }

    public switchDecoration() {
        if (this.ownDecoration !== null) {
            this.decorationRemovedHandler(this.ownDecoration);
        }

        this.bookmarkDecorationUpdatedHandler(this);
    }
}