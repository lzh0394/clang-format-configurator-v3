// Sample snippets for the editors (M4, plan §9 "C#/proto 代码示例").
//
// `App.tsx` used to inline one hard-coded C++ snippet. This module is the
// single source of truth for sample code: `DEFAULT_SAMPLE` is byte-identical to
// the old inline snippet (so existing sessions/defaults are unchanged), and the
// extra languages give the filename switcher something meaningful to show.
//
// The samples are deliberately "unformatted" (tight braces, no spaces after
// commas) so pressing Format visibly changes the right-hand pane.
//
// Usage from App.tsx (the Lead wires this up; nothing here imports React):
//
//   import { DEFAULT_SAMPLE, getSampleCode, isKnownSample } from "./editor/examples";
//   const [code, setCode] = useState(() => restored.state?.code ?? DEFAULT_SAMPLE);
//   // optional: follow the filename while the editor still holds a pristine sample
//   const changeFilename = (next: string) => {
//     const sample = getSampleCode(next);
//     if (sample !== null && isKnownSample(code)) setCode(sample);
//     setFilename(next);
//   };

import { languageForFilename } from "./languages";

/** The C++ sample shown on a fresh start (identical to the old `SAMPLE` const). */
export const CPP_SAMPLE = `#include <iostream>
#include <vector>

class Widget{public:
Widget(int id):id_(id){}
int id()const{return id_;}
void print()const{std::cout<<id_<<std::endl;}
private:
int id_;
};

int main(){std::vector<Widget> ws;ws.emplace_back(1);for(const auto&w:ws){w.print();}return 0;}
`;

export const CSHARP_SAMPLE = `using System;
using System.Collections.Generic;

namespace Demo{public sealed class Widget{
public Widget(int id){Id=id;}
public int Id{get;}
public void Print(){Console.WriteLine(Id);}
}

public static class Program{public static void Main(){var widgets=new List<Widget>{new Widget(1),new Widget(2)};foreach(var w in widgets){w.Print();}}}
}
`;

export const PROTO_SAMPLE = `syntax = "proto3";

package demo.v1;

message Widget{int32 id=1;string label=2;}

message GetWidgetRequest{int32 id=1;}

service WidgetService{rpc GetWidget(GetWidgetRequest)returns(Widget);}
`;

export const JAVA_SAMPLE = `import java.util.ArrayList;
import java.util.List;

public class Widget{private final int id;public Widget(int id){this.id=id;}public int id(){return id;}public void print(){System.out.println(id);}
public static void main(String[]args){List<Widget> ws=new ArrayList<>();ws.add(new Widget(1));for(Widget w:ws){w.print();}}}
`;

export const KOTLIN_SAMPLE = `data class Widget(val id:Int){fun print(){println(id)}}

fun main(){val widgets=listOf(Widget(1),Widget(2));for(w in widgets){w.print()}}
`;

export const JAVASCRIPT_SAMPLE = `const widgets=[1,2,3].map((id)=>{return{id:id,label:"w"+id};});
function printAll(list){for(const w of list){console.log(w.id);}}
printAll(widgets);
`;

export const TYPESCRIPT_SAMPLE = `type Widget={id:number;label:string;};
const widgets:Widget[]=[1,2,3].map((id)=>{return{id:id,label:"w"+id};});
function printAll(list:Widget[]):void{for(const w of list){console.log(w.id);}}
printAll(widgets);
`;

/** Sample used when nothing else is known; `main.cc` is the default filename. */
export const DEFAULT_SAMPLE = CPP_SAMPLE;
export const DEFAULT_SAMPLE_FILENAME = "main.cc";

/**
 * Samples keyed by editor language. Languages without an entry (Objective-C,
 * YAML, plain text) keep whatever the user already has in the editor.
 */
const SAMPLE_BY_LANGUAGE: Readonly<Record<string, string>> = {
  cpp: CPP_SAMPLE,
  java: JAVA_SAMPLE,
  csharp: CSHARP_SAMPLE,
  kotlin: KOTLIN_SAMPLE,
  javascript: JAVASCRIPT_SAMPLE,
  typescript: TYPESCRIPT_SAMPLE,
  proto: PROTO_SAMPLE,
};

const SAMPLE_CODES: ReadonlySet<string> = new Set(Object.values(SAMPLE_BY_LANGUAGE));

/**
 * Sample for an editor language, or null when there is none (keep the current
 * document). Never returns an empty string.
 */
export function getSampleForLanguage(language: string): string | null {
  const sample = SAMPLE_BY_LANGUAGE[language];
  return sample === undefined || sample === "" ? null : sample;
}

/**
 * Sample for a filename: `Program.cs` → the C# sample, `service.proto` → the
 * Protobuf sample. Unknown extensions (and empty names) return null.
 */
export function getSampleCode(filename: string): string | null {
  return getSampleForLanguage(languageForFilename(filename));
}

/**
 * True when `code` is one of the shipped samples. The app can use this to only
 * swap the example when the user has not typed anything yet.
 */
export function isKnownSample(code: string): boolean {
  return SAMPLE_CODES.has(code);
}
