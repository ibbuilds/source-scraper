import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import ts from "typescript";
test("authored product strings default to English",()=>{
 const spanish=/[áéíóúñ¿¡]|\b(?:Conectar|Guardar|Buscar|Recursos|Borradores|Opciones|Carpeta|Seleccionar|Pendiente|Aprobado|Descartado|Motivo|Volver|Reintentar)\b/iu;
 const scan=(directory:string)=>{
  for(const entry of readdirSync(directory,{withFileTypes:true})){
   const path=join(directory,entry.name);if(entry.isDirectory()){scan(path);continue;}if(!path.endsWith(".ts"))continue;
   const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,ts.LanguageVariant.Standard,readFileSync(path,"utf8"));
   for(let token=scanner.scan();token!==ts.SyntaxKind.EndOfFileToken;token=scanner.scan()){
    if([ts.SyntaxKind.StringLiteral,ts.SyntaxKind.NoSubstitutionTemplateLiteral,ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail].includes(token))assert.doesNotMatch(scanner.getTokenValue(),spanish,path+" contains an untranslated product string");
   }
  }
 };
 scan("apps/collector");scan("apps/obsidian-plugin");scan("packages");
});
