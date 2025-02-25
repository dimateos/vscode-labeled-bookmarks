import { Bookmark } from "./bookmark";
import { workspace } from "vscode";
import * as path from "path";
const workspaceFolder = workspace.workspaceFolders?.[0]?.uri.fsPath;

export class SerializableBookmark {
    fsPath: string;
    lineNumber: number;
    characterNumber: number;
    label?: string;
    lineText: string;
    isLineNumberChanged: boolean;
    groupName: string;

    constructor(
        fsPath: string,
        lineNumber: number,
        characterNumber: number,
        label: string | undefined,
        lineText: string,
        groupName: string
    ) {
        this.fsPath = fsPath;
        this.lineNumber = lineNumber;
        this.characterNumber = characterNumber;
        this.label = label;
        this.lineText = lineText;
        this.isLineNumberChanged = false;
        this.groupName = groupName;
    }

    public static fromBookmark(bookmark: Bookmark): SerializableBookmark {

        // Convert to relative only if the file is inside the workspace
        const relativePath = workspaceFolder && bookmark.fsPath.startsWith(workspaceFolder)
            ? path.relative(workspaceFolder, bookmark.fsPath)
            : bookmark.fsPath;

        return new SerializableBookmark(
            relativePath,
            bookmark.lineNumber,
            bookmark.characterNumber,
            bookmark.label,
            bookmark.lineText,
            bookmark.group.name
        );
    }
}