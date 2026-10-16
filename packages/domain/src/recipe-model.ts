import * as thermal from './recipe-program.js';
import * as universal from './universal-recipe.js';
export type RecipeDefinition=thermal.RecipeDefinition|universal.UniversalRecipe;
export type RecipeRunSnapshot=thermal.RecipeRunSnapshot|universal.UniversalSnapshot;
export function validateRecipeDefinition(input:unknown):RecipeDefinition {return universal.isUniversalRecipe(input)?universal.validateUniversalRecipe(input):thermal.validateRecipeDefinition(input);}
export function beginRecipeRun(input:unknown,now:number):RecipeRunSnapshot {return universal.isUniversalRecipe(input)?universal.beginUniversalRecipe(input,now):thermal.beginRecipeRun(input,now);}
export function abortRecipeRun(s:RecipeRunSnapshot,reason:string):RecipeRunSnapshot {return universal.isUniversalSnapshot(s)?universal.abortUniversalRecipe(s,reason):thermal.abortRecipeRun(s,reason);}
export function advanceRecipeRun(s:RecipeRunSnapshot,now:number,input:{permit:boolean;quality:string}):RecipeRunSnapshot {
 // Universal runs must never advance in the isolated thermal simulator.
 return universal.isUniversalSnapshot(s)?universal.abortUniversalRecipe(s,'Universal recipes require device bindings'):thermal.advanceRecipeRun(s,now,input);
}
export function recipeStepDescription(s:RecipeRunSnapshot):string {
 if(!universal.isUniversalSnapshot(s))return thermal.recipeStepDescription(s);
 return s.step==='Finishing'?'Verifying all outputs OFF':s.step==='Finished'?'Finished':`${s.stageIndex+1}: ${s.parameters.steps[s.stageIndex]!.name} (${s.step})`;
}
